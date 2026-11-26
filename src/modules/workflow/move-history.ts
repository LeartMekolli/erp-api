import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../../common/pagination/cursor';
import { paginationQuerySchema } from '../../common/pagination/page';
import { Prisma } from '../../generated/prisma/client';
import type { TenantAuth } from '../identity/auth-context';
import type { ActionResponse, MoveActor } from './move-history-response';
import { searchGroups } from './piece-filters';
import { readableAnswer, transitionInclude } from './transition-rows';
import type { WorkOrderStatus } from './work-order-response';
import type { MoveActorsQuery, MoveListQuery, TransitionQuery } from './work-orders.service';
import type { StepConfig } from './workflow-config';

// A line's moves, one item per action (Move history spec): every row one request wrote shares a `move_id`.

export const moveHistoryQuerySchema = paginationQuerySchema.extend({
  /** `fails`: only actions with a fail, or a correction that put a piece at a step. */
  only: z.enum(['fails']).optional(),
});
export type MoveHistoryQuery = z.infer<typeof moveHistoryQuerySchema>;

export const actionInclude = {
  ...transitionInclude,
  // With the user's kind, so a partner's list can tell its own people from the workspace's.
  actor: { select: { id: true, name: true, kind: true } },
  workOrder: { select: { id: true, number: true, replacesId: true, groupId: true, group: { select: { quantity: true } } } },
} as const satisfies Prisma.TransitionInclude;

export type ActionRow = Prisma.TransitionGetPayload<{ include: typeof actionInclude }>;

/** A fail, or a correction that put a piece at a step. A cancellation or a pass never is. */
const isFail = Prisma.sql`(t.kind = 'fail' OR (t.kind = 'correction' AND t.to_step_id IS NOT NULL))`;

/**
 * A page of the group's actions, newest first, each as its rows in this group, plus the counts over every
 * page. Paged by `move_id`, never by row, so an action is never split; three queries whatever the page size.
 */
export async function listActions(
  tx: Prisma.TransactionClient,
  groupId: string,
  query: MoveHistoryQuery,
  secret: string,
): Promise<{ actions: ActionRow[][]; next_cursor: string | null; counts: { all: number; fails: number } }> {
  const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
  // Row-level security hides other workspaces' groups, so a foreign id is simply not found.
  if (!(await tx.workOrderGroup.findUnique({ where: { id: groupId }, select: { id: true } }))) {
    throw new NotFoundException('Group not found');
  }

  const conditions = [Prisma.sql`w.group_id = ${groupId}::uuid`];
  if (after) conditions.push(Prisma.sql`t.move_id < ${after.id}::uuid`);
  if (query.only === 'fails') conditions.push(isFail);
  const page = await tx.$queryRaw<{ move_id: string }[]>`
    SELECT t.move_id FROM transition t JOIN work_order w ON w.id = t.work_order_id
    WHERE ${Prisma.join(conditions, ' AND ')}
    GROUP BY t.move_id ORDER BY t.move_id DESC LIMIT ${query.limit + 1}`;
  const [counts] = await tx.$queryRaw<{ all: number; fails: number }[]>`
    SELECT count(DISTINCT t.move_id)::int AS "all", (count(DISTINCT t.move_id) FILTER (WHERE ${isFail}))::int AS fails
    FROM transition t JOIN work_order w ON w.id = t.work_order_id
    WHERE w.group_id = ${groupId}::uuid`;

  const ids = page.slice(0, query.limit).map((row) => row.move_id);
  // Another group's pieces in the same move stay out: each line lists only its own.
  const rows =
    ids.length > 0
      ? await tx.transition.findMany({ where: { moveId: { in: ids }, workOrder: { groupId } }, include: actionInclude, orderBy: { id: 'asc' } })
      : [];
  const byMove = new Map<string, ActionRow[]>(ids.map((id) => [id, []]));
  for (const row of rows) {
    byMove.get(row.moveId)!.push(row);
  }
  return {
    actions: ids.map((id) => byMove.get(id)!),
    next_cursor: page.length > query.limit ? encodeCursor({ id: ids.at(-1)! }, secret) : null,
    counts: { all: counts.all, fails: counts.fails },
  };
}

/** The rows `GET /workflow/transitions` filters to, shared with the moves list so both read the same. */
export function transitionFilters(query: TransitionQuery): Prisma.TransitionWhereInput {
  const group = {
    ...(query.group_id ? { id: query.group_id } : {}),
    ...(query.file_version_id ? { fileVersionId: query.file_version_id } : {}),
  };
  return {
    ...(query.work_order_id ? { workOrderId: query.work_order_id } : {}),
    ...(query.move_id ? { moveId: query.move_id } : {}),
    ...(Object.keys(group).length > 0 ? { workOrder: { group } } : {}),
    ...(query.step_key ? { fromStep: { key: query.step_key } } : {}),
    ...(query.defect_key ? { defect: { key: query.defect_key } } : {}),
    ...(query.actor_user_id ? { actorUserId: query.actor_user_id } : {}),
    ...(query.inspected ? { inspected: query.inspected === 'true' } : {}),
    ...(query.from || query.to
      ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lt: new Date(query.to) } : {}) } }
      : {}),
  };
}

/** What a moves list cursor carries besides the move id, so another list's cursor is refused. */
const MOVES_CURSOR = 'moves';

/**
 * A page of every line's moves, newest first, each as all its rows, every line it touched included: the
 * filters pick the moves, never the rows within one. Paged by `move_id`, as `listActions` is; two queries
 * whatever the page size, `q` and every filter run in the database.
 */
export async function listMoves(
  tx: Prisma.TransactionClient,
  query: MoveListQuery,
  auth: TenantAuth,
  secret: string,
): Promise<{ moves: ActionRow[][]; next_cursor: string | null }> {
  const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
  if (after && after.sort !== MOVES_CURSOR) throw new BadRequestException('Invalid cursor: made for another list');
  const group: Prisma.WorkOrderGroupWhereInput[] = [
    ...(query.workflow_id ? [{ workflowVersion: { workflowId: query.workflow_id } }] : []),
    ...(query.q ? [searchGroups(query.q, auth)] : []),
  ];
  const page = await tx.transition.groupBy({
    by: ['moveId'],
    where: {
      AND: [
        transitionFilters(query),
        ...(query.kind ? [{ kind: query.kind }] : []),
        ...(group.length > 0 ? [{ workOrder: { group: { AND: group } } }] : []),
        ...(after ? [{ moveId: { lt: after.id } }] : []),
      ],
    },
    orderBy: { moveId: 'desc' },
    take: query.limit + 1,
  });
  const ids = page.slice(0, query.limit).map((row) => row.moveId);
  const rows = ids.length > 0 ? await tx.transition.findMany({ where: { moveId: { in: ids } }, include: actionInclude, orderBy: { id: 'asc' } }) : [];
  const byMove = new Map<string, ActionRow[]>(ids.map((id) => [id, []]));
  for (const row of rows) {
    byMove.get(row.moveId)!.push(row);
  }
  return {
    moves: ids.map((id) => byMove.get(id)!),
    next_cursor: page.length > query.limit ? encodeCursor({ id: ids.at(-1)!, sort: MOVES_CURSOR }, secret) : null,
  };
}

/**
 * Everyone who has made a move (Move actors spec, 2026-11-26), by name then id, each with the partners they
 * belong to now, by name. Deactivated people stay: History still names them. At most three queries whatever the size.
 */
export async function listActors(tx: Prisma.TransactionClient, query: MoveActorsQuery): Promise<MoveActor[]> {
  const moved = await tx.transition.groupBy({
    by: ['actorUserId'],
    where: query.workflow_id ? { workOrder: { group: { workflowVersion: { workflowId: query.workflow_id } } } } : {},
  });
  if (moved.length === 0) return [];
  const users = await tx.user.findMany({
    where: { id: { in: moved.map((row) => row.actorUserId) } },
    select: { id: true, name: true, memberships: { where: { organisationType: 'partner' }, select: { organisationId: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  const partners = await tx.partner.findMany({
    where: { id: { in: users.flatMap((user) => user.memberships.map((membership) => membership.organisationId)) } },
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  return users.map((user) => {
    const ids = new Set(user.memberships.map((membership) => membership.organisationId));
    return { id: user.id, name: user.name, partners: partners.filter((partner) => ids.has(partner.id)) };
  });
}

interface StepRef {
  id: string;
  key: string;
  name: string;
}

/** The step every piece shares, by id; null when they differ. */
function shared(steps: (StepRef | null)[]): StepRef | null {
  const first = steps[0] ?? null;
  return steps.every((step) => step?.id === first?.id) ? first : null;
}

const stepOf = (step: StepRef | null): StepRef | null => (step ? { id: step.id, key: step.key, name: step.name } : null);

/**
 * Everything of an action but who made it, the partner and free text, which each list shows its own way.
 * What every row shares is read from the first row that didn't cancel a piece: a restore's cancelled
 * replacements carry only the comment.
 */
export function actionFacts(rows: ActionRow[]) {
  const representative = rows.find((row) => row.toStatus !== 'cancelled') ?? rows[0];
  const checklist = representative.fromStep ? (representative.fromStep.config as StepConfig).checklist : undefined;
  const pieces = [...rows]
    .sort(
      (a, b) =>
        a.workOrder.number - b.workOrder.number || Number(a.workOrder.replacesId !== null) - Number(b.workOrder.replacesId !== null),
    )
    .map((row) => ({
      id: row.workOrder.id,
      label: `${row.workOrder.number}/${row.workOrder.group.quantity}`,
      replacement: row.workOrder.replacesId !== null,
      from_step: stepOf(row.fromStep),
      to_step: row.toStep,
      status: row.toStatus as WorkOrderStatus,
    }));
  return {
    id: representative.moveId,
    kind: representative.kind as ActionResponse['kind'],
    outcome: representative.outcome as ActionResponse['outcome'],
    from_step: shared(rows.map((row) => stepOf(row.fromStep))),
    to_step: shared(rows.map((row) => row.toStep)),
    defect: representative.defect,
    answers: representative.answers.map((answer) => readableAnswer(answer, checklist)),
    photos: representative.photos.map((photo) => ({ file_id: photo.fileVersion.fileId, file_version_id: photo.fileVersionId })),
    inspected: representative.inspected,
    created_at: representative.createdAt.toISOString(),
    pieces,
    representative,
  };
}
