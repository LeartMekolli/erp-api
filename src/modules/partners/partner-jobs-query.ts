import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import type { CursorPayload } from '../../common/pagination/cursor';
import { paginationQuerySchema } from '../../common/pagination/page';
import { commaList } from '../../common/validation/comma-list';
import { likeLiteral } from '../../database/like';
import type { JobAssignment, Prisma } from '../../generated/prisma/client';
import type { NeedsDay } from '../orders/needs';
import { notWaitingForPayment } from '../orders/payment-hold';
import { liveOpen } from './eligibility.service';
import { PARTNER_JOB_STATUSES } from './partner-response';

type Tx = Prisma.TransactionClient;
type PartnerJobStatus = (typeof PARTNER_JOB_STATUSES)[number];

export const PARTNER_JOB_SORTS = ['-offered_at', 'offered_at', 'due_on', '-due_on'] as const;
export type PartnerJobSort = (typeof PARTNER_JOB_SORTS)[number];

/** Of the jobs the partner is working on: past their due date, or due from today to 2 working days on. */
export const PARTNER_JOB_DUE = ['late', 'due_soon'] as const;
export type PartnerJobDue = (typeof PARTNER_JOB_DUE)[number];

/** The partner's jobs list: its tab, tiles, search and sort, combined with AND (partner jobs list spec, 2026-11-21). */
export const partnerJobsQuerySchema = z.strictObject({
  ...paginationQuerySchema.shape,
  status: z.enum(PARTNER_JOB_STATUSES).optional(),
  due: commaList(PARTNER_JOB_DUE)
    .optional()
    .describe(
      "`late`, `due_soon` or both, comma-separated: jobs the partner is working on (`accepted`) past their due date, or due from the workspace's today to 2 working days on.",
    ),
  q: z.string().trim().min(1).max(100).optional().describe('Part of the product name, or of a chosen option value; case-insensitive.'),
  sort: z.enum(PARTNER_JOB_SORTS).default('-offered_at').describe('Ties break by id in the same direction; jobs with no due date come last in both `due_on` sorts.'),
});
export type PartnerJobsQuery = z.infer<typeof partnerJobsQuerySchema>;

/** The counts take only the search: the tab, the tiles, paging and sort are what they count, and a 400 here. */
export const partnerJobsCountsQuerySchema = partnerJobsQuerySchema.pick({ q: true });
export type PartnerJobsCountsQuery = z.infer<typeof partnerJobsCountsQuerySchema>;

export interface PartnerJobsFilters {
  status?: PartnerJobStatus;
  due?: PartnerJobDue[];
  q?: string;
}

/**
 * What the filters are decided against, read once per request: `open`, the partner's accepted jobs it
 * still has work on (`openForPartner`), when `status` or `due` needs it; `day`, the workspace's today, when
 * `due` is set; `found`, the jobs `q` finds (`searchJobs`), when it is set.
 */
export interface PartnerJobsContext {
  open: Set<string>;
  day: NeedsDay | null;
  found: Set<string> | null;
  now: Date;
}

const asDay = (day: string) => new Date(`${day}T00:00:00Z`);

/**
 * The partner's rows of the jobs in one status, decided in the query so a page is never short. An offer
 * past its deadline is gone at once, before the expiry run marks it expired.
 */
function statusWhere(status: PartnerJobStatus | undefined, open: Set<string>, now: Date): Prisma.JobAssignmentWhereInput {
  switch (status) {
    case 'offered':
      return { status: 'offered', expiresAt: { gt: now } };
    case 'accepted':
      return { status: 'accepted', groupId: { in: [...open] } };
    case 'finished':
      return { status: 'accepted', groupId: { notIn: [...open] } };
    default:
      return liveOpen(now);
  }
}

/** Late and due soon are only jobs the partner is working on; a job with no due date is neither. */
function dueWhere(due: PartnerJobDue[], open: Set<string>, day: NeedsDay): Prisma.JobAssignmentWhereInput {
  const rules: Record<PartnerJobDue, Prisma.JobAssignmentWhereInput> = {
    late: { dueOn: { lt: asDay(day.today) } },
    due_soon: { dueOn: { gte: asDay(day.today), lte: asDay(day.dueSoonUntil) } },
  };
  return { status: 'accepted', groupId: { in: [...open] }, OR: due.map((reason) => rules[reason]) };
}

/**
 * The partner's jobs whose product name contains `q`, or with a chosen option value whose name does, in one
 * query over the partner's own jobs, however many option values match. Options are read from the job's
 * quote and matched by group and value key, the same rule the row's `options` are named by
 * (`chosenOptions`): a job keeps an option its product no longer offers, so its product isn't asked.
 */
export async function searchJobs(tx: Tx, partnerId: string, q: string): Promise<Set<string>> {
  const pattern = `%${likeLiteral(q)}%`;
  const rows = await tx.$queryRaw<{ group_id: string }[]>`
    SELECT DISTINCT ja.group_id FROM job_assignment ja
    JOIN work_order_group g ON g.id = ja.group_id
    LEFT JOIN product p ON p.id = g.product_id
    LEFT JOIN quote qu ON qu.id = g.quote_id
    WHERE ja.partner_id = ${partnerId}::uuid
      AND (
        p.name ILIKE ${pattern}
        OR EXISTS (
          SELECT 1 FROM jsonb_each_text(qu.inputs -> 'options') AS chosen(group_key, value_key)
          JOIN option_group og ON og.key = chosen.group_key
          JOIN option_value ov ON ov.group_id = og.id AND ov.key = chosen.value_key
          WHERE ov.name ILIKE ${pattern}
        )
      )`;
  return new Set(rows.map((row) => row.group_id));
}

/** The partner's jobs the filters pick: never another partner's, nor one of an order waiting for payment. */
export function partnerJobsWhere(partnerId: string, filters: PartnerJobsFilters, context: PartnerJobsContext): Prisma.JobAssignmentWhereInput {
  return {
    AND: [
      { partnerId },
      statusWhere(filters.status, context.open, context.now),
      ...(filters.due && context.day ? [dueWhere(filters.due, context.open, context.day)] : []),
      ...(filters.q && context.found ? [{ groupId: { in: [...context.found] } }] : []),
      { group: notWaitingForPayment },
    ],
  };
}

const NO_DUE_DATE = 'none';
const byDue = (sort: PartnerJobSort) => sort === 'due_on' || sort === '-due_on';

/** The list's order: by hand-over (the id, which follows it), or by due date with undated jobs last, then id. */
export function partnerJobsOrderBy(sort: PartnerJobSort): Prisma.JobAssignmentOrderByWithRelationInput[] {
  const direction = sort.startsWith('-') ? ('desc' as const) : ('asc' as const);
  return byDue(sort) ? [{ dueOn: { sort: direction, nulls: 'last' } }, { id: direction }] : [{ id: direction }];
}

/** Where a page starts, after the cursor's row, in the sort's direction. */
export function partnerJobsPageWhere(sort: PartnerJobSort, after: CursorPayload): Prisma.JobAssignmentWhereInput {
  const past = <T>(value: T) => (sort.startsWith('-') ? { lt: value } : { gt: value });
  if (!byDue(sort)) return { id: past(after.id) };
  if (after.key === NO_DUE_DATE) return { dueOn: null, id: past(after.id) };
  const day = asDay(after.key!);
  return { OR: [{ dueOn: past(day) }, { dueOn: day, id: past(after.id) }, { dueOn: null }] };
}

/** The cursor for `sort`, refused (400) when made for another sort or when its key isn't that sort's. */
export function partnerJobsCursor(sort: PartnerJobSort, cursor: string, secret: string): CursorPayload {
  const after = decodeCursor(cursor, secret);
  const keyOk = byDue(sort) ? after.key === NO_DUE_DATE || z.iso.date().safeParse(after.key).success : after.key === undefined;
  if ((after.sort ?? '-offered_at') !== sort || !keyOk) throw new BadRequestException('Invalid cursor');
  return after;
}

/** What the next page's cursor carries for `sort`: nothing more than the id when newest first, as before. */
export function partnerJobsCursorPayload(sort: PartnerJobSort, row: JobAssignment): CursorPayload {
  if (sort === '-offered_at') return { id: row.id };
  if (!byDue(sort)) return { id: row.id, sort };
  return { id: row.id, sort, key: row.dueOn ? row.dueOn.toISOString().slice(0, 10) : NO_DUE_DATE };
}
