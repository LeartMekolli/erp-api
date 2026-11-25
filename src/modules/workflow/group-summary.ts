import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { bandInForce, prioritySettings } from '../customers/priority/bands';
import type { TenantAuth } from '../identity/auth-context';
import { linePicksSchema } from '../orders/line-picks';
import { workspaceToday } from '../orders/order-lines';
import type { SettingsService } from '../settings/settings.service';
import type { GroupSummary } from './group-summary-response';

export type { GroupSummary } from './group-summary-response';

type Tx = Prisma.TransactionClient;

// Not strict: the stored picks also hold `design_file`, which the summary leaves out.
const optionsAndSize = z.object({ options: linePicksSchema.shape.options, size: linePicksSchema.shape.size });
const picksOf = (value: Prisma.JsonValue) => {
  const picks = optionsAndSize.safeParse(value);
  return picks.success ? picks.data : { options: [], size: null };
};
const dayOf = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;

/** The summaries of `groupIds`, in a fixed number of reads whatever their count. */
export async function groupSummaries(tx: Tx, groupIds: string[], auth: TenantAuth, settings: SettingsService): Promise<Map<string, GroupSummary>> {
  const ids = [...new Set(groupIds)];
  if (ids.length === 0) return new Map();
  const mayOrder = auth.permissions.has('order.read');
  const mayCustomer = auth.permissions.has('customer.read');
  const orderOf = { select: { id: true, number: true } } as const;

  const groups = await tx.workOrderGroup.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      sourceType: true,
      customerId: true,
      dueOn: true,
      workflowVersion: { select: { number: true, workflow: { select: { id: true, name: true } } } },
      product: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true } },
      orderLine: { select: { id: true, picks: true, order: orderOf } },
      orderLinePart: { select: { picks: true, line: { select: { id: true, order: orderOf } } } },
      remakeOf: { select: { orderLine: { select: { id: true, picks: true } }, claim: { select: { id: true, number: true, order: orderOf } } } },
    },
  });
  const jobs = await tx.jobAssignment.findMany({
    where: { groupId: { in: ids }, status: 'accepted' },
    select: { groupId: true, dueOn: true, partner: { select: { id: true, name: true } } },
  });
  const jobOf = new Map(jobs.map((job) => [job.groupId, job]));
  // Per group: whether a piece is still active, and whether one is at a step the partner does.
  const live = await tx.$queryRaw<{ group_id: string; at_partner: boolean }[]>`
    SELECT wo.group_id AS group_id, bool_or(ws.done_by = 'partner') AS at_partner
    FROM work_order wo JOIN workflow_step ws ON ws.id = wo.current_step_id
    WHERE wo.status = 'active' AND wo.group_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    GROUP BY wo.group_id`;
  const liveOf = new Map(live.map((row) => [row.group_id, row.at_partner]));
  const customerIds = [...new Set(groups.flatMap((group) => (group.customerId ? [group.customerId] : [])))];
  const priorities =
    customerIds.length > 0
      ? await tx.customerPriority.findMany({
          where: { customerId: { in: customerIds } },
          select: { customerId: true, bandKey: true, overrideBandKey: true, overrideEndsOn: true },
        })
      : [];
  const priorityOf = new Map(priorities.map((row) => [row.customerId, row]));
  const bands = customerIds.length > 0 ? await prioritySettings(tx, settings) : null;
  const today = await workspaceToday(tx, auth.tenantId);

  const summaries = new Map<string, GroupSummary>();
  for (const group of groups) {
    const part = group.orderLinePart;
    const remake = group.remakeOf;
    const source: GroupSummary['source'] =
      group.sourceType === 'claim_line' ? 'claim_line' : group.sourceType === 'quote' ? 'quote' : part ? 'order_line_part' : 'order_line';
    const picks = group.orderLine?.picks ?? part?.picks ?? remake?.orderLine.picks;
    const order = group.orderLine
      ? { ...group.orderLine.order, line_id: group.orderLine.id }
      : part
        ? { ...part.line.order, line_id: part.line.id }
        : remake
          ? { ...remake.claim.order, line_id: remake.orderLine.id }
          : null;
    const dueOn = dayOf(group.dueOn);
    const active = liveOf.has(group.id);
    const job = jobOf.get(group.id);
    const jobDue = dayOf(job?.dueOn ?? null);
    summaries.set(group.id, {
      id: group.id,
      workflow: { id: group.workflowVersion.workflow.id, name: group.workflowVersion.workflow.name, version: group.workflowVersion.number },
      product: group.product ? { ...group.product, ...(picks === undefined ? { options: [], size: null } : picksOf(picks)) } : null,
      source,
      ...(mayOrder ? { order, claim: remake ? { id: remake.claim.id, number: remake.claim.number } : null } : {}),
      ...(mayCustomer ? { customer: group.customer } : {}),
      due_on: dueOn,
      late: dueOn !== null && dueOn < today && active,
      priority: group.customerId && bands ? (({ key, name }) => ({ key, name }))(bandInForce(priorityOf.get(group.customerId) ?? null, today, bands)) : null,
      partner: job ? { ...job.partner, due_on: jobDue, late: jobDue !== null && jobDue < today && liveOf.get(group.id) === true } : null,
    });
  }
  return summaries;
}
