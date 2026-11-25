import type { Prisma } from '../../generated/prisma/client';
import { waitingForPayment, waitingGroupIds } from '../orders/payment-hold';

// Why an active piece can't be moved now, whoever moves it (held pieces spec, 2026-11-25). The work lists
// read the same rules the move guards refuse by, so a piece they offer as workable always moves.

export const HOLD_REASONS = ['waiting_for_payment', 'waiting_for_parts'] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** A part not ready: an active piece, or no finished one (what `groupReady` says no to). */
export const partNotReady: Prisma.WorkOrderGroupWhereInput = {
  OR: [{ workOrders: { some: { status: 'active' } } }, { workOrders: { none: { status: 'finished' } } }],
};

/**
 * Of the groups `where` picks, those with a part not ready. A move of their pieces may only land on the
 * path's first step, wherever they are, so none of their active pieces can be passed or failed onward.
 */
export async function groupsWaitingForParts(tx: Prisma.TransactionClient, where: Prisma.WorkOrderGroupWhereInput): Promise<Set<string>> {
  const rows = await tx.workOrderGroup.findMany({ where: { AND: [where, { children: { some: partNotReady } }] }, select: { id: true } });
  return new Set(rows.map((row) => row.id));
}

export interface HeldPiece {
  id: string;
  groupId: string;
  status: string;
}

export interface Holds {
  /** The active pieces that are held. */
  held: Prisma.WorkOrderWhereInput;
  /** Why each held one of `pieces` is, by piece id; a piece not held isn't in it. Payment first. */
  reasons(pieces: HeldPiece[]): Promise<Map<string, HoldReason>>;
}

/**
 * The holds in force: every active piece of an order waiting for payment, and every active piece of an
 * assembly while a part isn't ready (the move guard refuses all but a move back to the first step).
 */
export async function readHolds(tx: Prisma.TransactionClient): Promise<Holds> {
  const forParts = await groupsWaitingForParts(tx, { workOrders: { some: { status: 'active' } } });
  return {
    held: { status: 'active', OR: [{ group: waitingForPayment }, { groupId: { in: [...forParts] } }] },
    async reasons(pieces) {
      const active = pieces.filter((piece) => piece.status === 'active');
      const unpaid = await waitingGroupIds(tx, [...new Set(active.map((piece) => piece.groupId))]);
      const reasons = new Map<string, HoldReason>();
      for (const piece of active) {
        if (unpaid.has(piece.groupId)) reasons.set(piece.id, 'waiting_for_payment');
        else if (forParts.has(piece.groupId)) reasons.set(piece.id, 'waiting_for_parts');
      }
      return reasons;
    },
  };
}
