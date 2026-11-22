import { Prisma } from '../../generated/prisma/client';
import type { WorkflowStepRow } from '../workflow/coverage';
import { OWED_STATUSES, payoutPositionOf } from './jobs.service';
import { owedFor, passedPayout } from './owed';
import { openForPartner, pathOf } from './partner-jobs.service';

/**
 * When a partner job became owed, and when the partner's part of it ended (dashboard data spec, "When a
 * job became owed"), read from its pieces' moves, so reports and the partner's own summary never disagree.
 */

type Tx = Prisma.TransactionClient;

/** One move of one piece: where it was and where it went, by step position. */
export interface PieceMoveFact {
  workOrderId: string;
  at: Date;
  /** Null when the piece wasn't at a step (finished, scrapped). */
  fromPosition: number | null;
  /** Null when the piece didn't land on a step. */
  toPosition: number | null;
  fromStatus: string;
  toStatus: string;
}

/** What a partner became owed for a hand-over, and when. */
export interface OwedEntry {
  assignmentId: string;
  partnerId: string;
  groupId: string;
  at: Date;
  amount: Prisma.Decimal;
  /** What pending and paid payouts hold for it. */
  paid: Prisma.Decimal;
}

/** Pieces still to make or made; scrapped and cancelled ones are replaced or gone (as `owed.ts`). */
const LIVE = new Set(['active', 'finished']);
/** A move that takes a piece out of the job: it can be what leaves every live piece past the payout step. */
const GONE = new Set(['scrapped', 'cancelled']);

const latest = (dates: Date[]): Date | null =>
  dates.reduce<Date | null>((last, at) => (last === null || at > last ? at : last), null);

/**
 * The moment an accepted job became owed: none unless every live piece has passed the payout step now.
 * Otherwise the latest of each live piece's last move past the payout step, and of every move scrapping
 * or cancelling one of the job's pieces. A correction back before the payout step takes the moment away
 * until the piece passes again; the pass after it is the one that counts.
 */
export function owedAt(
  pieces: { id: string; status: string; passedPayout: boolean }[],
  moves: PieceMoveFact[],
  payoutPosition: number,
): Date | null {
  const live = pieces.filter((piece) => LIVE.has(piece.status));
  if (live.length === 0 || !live.every((piece) => piece.passedPayout)) return null;
  const liveIds = new Set(live.map((piece) => piece.id));
  const counted = moves.filter((move) => {
    if (GONE.has(move.toStatus)) return true;
    if (!liveIds.has(move.workOrderId)) return false;
    const wasPast = passedPayout({ status: move.fromStatus, stepPosition: move.fromPosition }, payoutPosition);
    const isPast = passedPayout({ status: move.toStatus, stepPosition: move.toPosition }, payoutPosition);
    return !wasPast && isPast;
  });
  return latest(counted.map((move) => move.at));
}

/**
 * The moment the partner's part of a job ended: its last move off the last partner step on the path, or
 * off a step before it. A later move between two of the workspace's own steps doesn't count. None
 * without such a move.
 */
export function partnerDoneAt(moves: PieceMoveFact[], lastPartnerPosition: number): Date | null {
  return latest(
    moves.filter((move) => move.fromPosition !== null && move.fromPosition <= lastPartnerPosition).map((move) => move.at),
  );
}

const MOVE_SELECT = {
  workOrderId: true,
  createdAt: true,
  fromStatus: true,
  toStatus: true,
  fromStep: { select: { position: true } },
  toStep: { select: { position: true } },
} satisfies Prisma.TransitionSelect;

type MoveRow = Prisma.TransitionGetPayload<{ select: typeof MOVE_SELECT }>;

function toFact(row: MoveRow): PieceMoveFact {
  return {
    workOrderId: row.workOrderId,
    at: row.createdAt,
    fromPosition: row.fromStep?.position ?? null,
    toPosition: row.toStep?.position ?? null,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
  };
}

/** Moves grouped by job, given which job each piece is of. */
function movesByGroup(rows: MoveRow[], groupOf: Map<string, string>): Map<string, PieceMoveFact[]> {
  const byGroup = new Map<string, PieceMoveFact[]>();
  for (const row of rows) {
    const groupId = groupOf.get(row.workOrderId);
    if (groupId === undefined) continue;
    const moves = byGroup.get(groupId);
    if (moves) {
      moves.push(toFact(row));
    } else {
      byGroup.set(groupId, [toFact(row)]);
    }
  }
  return byGroup;
}

/**
 * What partners became owed in `[from, to)`, of every partner or only `partnerId`'s hand-overs. An
 * accepted job is dated by `owedAt`; a replaced one by when the job's next hand-over was made; a cancelled
 * one by when its order line was cancelled. An amount of 0 is left out. Four queries, whatever
 * the number of jobs.
 */
export async function owedBetween(tx: Tx, from: Date, to: Date, partnerId?: string): Promise<OwedEntry[]> {
  const range = { gte: from, lt: to };
  // A job can only become owed in the range by a move in it, when replaced by a hand-over made in it, or
  // when cancelled by its order line being cancelled in it.
  const groups = await tx.workOrderGroup.findMany({
    where: {
      OR: [
        { workOrders: { some: { transitions: { some: { createdAt: range } } } } },
        { assignments: { some: { createdAt: range } } },
        { orderLine: { is: { cancelledAt: range } } },
        { orderLinePart: { is: { line: { is: { cancelledAt: range } } } } },
      ],
      ...(partnerId !== undefined ? { assignments: { some: { partnerId, status: { in: OWED_STATUSES } } } } : {}),
    },
    select: {
      id: true,
      workflowVersion: { select: { payoutStepId: true, steps: { select: { id: true, position: true, doneBy: true } } } },
      workOrders: { select: { id: true, status: true, currentStep: { select: { position: true } } } },
      orderLine: { select: { cancelledAt: true } },
      orderLinePart: { select: { line: { select: { cancelledAt: true } } } },
    },
  });
  if (groups.length === 0) return [];
  const groupIds = groups.map((group) => group.id);

  // Every hand-over of those jobs, in hand-over order: a replaced one is dated by the one after it.
  const handOvers = await tx.jobAssignment.findMany({
    where: { groupId: { in: groupIds } },
    select: { id: true, groupId: true, partnerId: true, status: true, cost: true, owedOverride: true, createdAt: true },
    orderBy: { id: 'asc' },
  });
  const nextMadeAt = new Map<string, Date>();
  const lastOfGroup = new Map<string, string>();
  for (const handOver of handOvers) {
    const previous = lastOfGroup.get(handOver.groupId);
    if (previous !== undefined) nextMadeAt.set(previous, handOver.createdAt);
    lastOfGroup.set(handOver.groupId, handOver.id);
  }
  const owedRows = handOvers.filter(
    (handOver) => OWED_STATUSES.includes(handOver.status) && (partnerId === undefined || handOver.partnerId === partnerId),
  );
  if (owedRows.length === 0) return [];

  const groupOf = new Map(groups.flatMap((group) => group.workOrders.map((piece) => [piece.id, group.id] as const)));
  const moveRows = await tx.transition.findMany({ where: { workOrder: { groupId: { in: groupIds } } }, select: MOVE_SELECT });
  const moves = movesByGroup(moveRows, groupOf);

  const held = await tx.payoutJob.groupBy({
    by: ['assignmentId'],
    _sum: { amount: true },
    where: { assignmentId: { in: owedRows.map((row) => row.id) }, payout: { status: { in: ['pending', 'paid'] } } },
  });
  const paidFor = new Map(held.map((entry) => [entry.assignmentId, entry._sum.amount ?? new Prisma.Decimal(0)]));

  const byId = new Map(groups.map((group) => [group.id, group]));
  return owedRows.flatMap((row) => {
    const group = byId.get(row.groupId)!;
    const groupMoves = moves.get(row.groupId) ?? [];
    const payoutPosition = payoutPositionOf(group.workflowVersion);
    const pieces = group.workOrders.map((piece) => ({
      id: piece.id,
      status: piece.status,
      passedPayout: passedPayout({ status: piece.status, stepPosition: piece.currentStep?.position ?? null }, payoutPosition),
    }));
    const owed = owedFor(row, pieces);
    if (owed === null || owed.state !== 'owed' || owed.amount.isZero()) return [];
    let at: Date | null = null;
    if (row.status === 'accepted') {
      // A job handed over again after its pieces passed the payout step keeps the date of that pass.
      at = owedAt(pieces, groupMoves, payoutPosition);
    } else if (row.status === 'replaced') {
      at = nextMadeAt.get(row.id) ?? null;
    } else if (row.status === 'cancelled') {
      // When its order line, or the line of the assembly it's a part of, was cancelled: a line whose pieces
      // were all finished is cancelled without a move. Without that date it counts nowhere.
      at = group.orderLine?.cancelledAt ?? group.orderLinePart?.line.cancelledAt ?? null;
    }
    if (at === null || at < from || at >= to) return [];
    return [
      {
        assignmentId: row.id,
        partnerId: row.partnerId,
        groupId: row.groupId,
        at,
        amount: owed.amount,
        paid: paidFor.get(row.id) ?? new Prisma.Decimal(0),
      },
    ];
  });
}

/**
 * How many of the partner's accepted jobs it finished its part of in `[from, to)`: those it has no work
 * left on now (not in `openForPartner`), dated by `partnerDoneAt` against the last partner step on the
 * job's path. Four queries, whatever the number of jobs.
 */
export async function finishedBetween(tx: Tx, partnerId: string, from: Date, to: Date): Promise<number> {
  const open = await openForPartner(tx, { partnerId });
  const accepted = await tx.jobAssignment.findMany({
    where: { partnerId, status: 'accepted', groupId: { notIn: [...open] } },
    select: { group: true },
  });
  if (accepted.length === 0) return 0;
  const groups = accepted.map((row) => row.group);

  const steps: WorkflowStepRow[] = await tx.workflowStep.findMany({
    where: { versionId: { in: [...new Set(groups.map((group) => group.workflowVersionId))] } },
    include: { stepType: true },
  });
  const stepsOf = new Map<string, WorkflowStepRow[]>();
  for (const step of steps) stepsOf.set(step.versionId, [...(stepsOf.get(step.versionId) ?? []), step]);

  // Only moves from `from` on can date a job in the range: an earlier last move dates it before it.
  const moveRows = await tx.transition.findMany({
    where: { createdAt: { gte: from }, workOrder: { groupId: { in: groups.map((group) => group.id) } } },
    select: { ...MOVE_SELECT, workOrder: { select: { groupId: true } } },
  });
  const groupOf = new Map(moveRows.map((row) => [row.workOrderId, row.workOrder.groupId] as const));
  const moves = movesByGroup(moveRows, groupOf);

  return groups.filter((group) => {
    const lastPartner = pathOf(stepsOf.get(group.workflowVersionId) ?? [], group)
      .filter((step) => step.doneBy === 'partner')
      .at(-1);
    if (lastPartner === undefined) return false;
    const at = partnerDoneAt(moves.get(group.id) ?? [], lastPartner.position);
    return at !== null && at >= from && at < to;
  }).length;
}
