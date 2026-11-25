import type { Prisma } from '../../generated/prisma/client';
import { waitingForPayment, waitingGroupIds } from '../orders/payment-hold';
import { pathFor } from './path';

// Why an active piece can't be moved now, whoever moves it (held pieces spec, 2026-11-25). The work lists
// read the same rules the move guards refuse by, so a piece they offer as workable always moves.

export const HOLD_REASONS = ['waiting_for_payment', 'waiting_for_parts'] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** A part not ready: an active piece, or no finished one (what `groupReady` says no to). */
export const partNotReady: Prisma.WorkOrderGroupWhereInput = {
  OR: [{ workOrders: { some: { status: 'active' } } }, { workOrders: { none: { status: 'finished' } } }],
};

/** Of the groups `where` picks, those with a part not ready: their pieces stay at their first step. */
export async function groupsWaitingForParts(tx: Prisma.TransactionClient, where: Prisma.WorkOrderGroupWhereInput): Promise<Set<string>> {
  const rows = await tx.workOrderGroup.findMany({ where: { AND: [where, { children: { some: partNotReady } }] }, select: { id: true } });
  return new Set(rows.map((row) => row.id));
}

export interface HeldPiece {
  id: string;
  groupId: string;
  status: string;
  currentStepId: string | null;
}

export interface Holds {
  /** The active pieces that are held. */
  held: Prisma.WorkOrderWhereInput;
  /** Why each held one of `pieces` is, by piece id; a piece not held isn't in it. Payment first. */
  reasons(pieces: HeldPiece[]): Promise<Map<string, HoldReason>>;
}

/**
 * The holds in force: every active piece of an order waiting for payment, and an assembly's active pieces
 * at its first path step while a part isn't ready. Only groups waiting for parts are read, with their
 * version's steps, so the filter stays one clause per such group whatever the size of the list.
 */
export async function readHolds(tx: Prisma.TransactionClient): Promise<Holds> {
  const waiting = await tx.workOrderGroup.findMany({
    where: { workOrders: { some: { status: 'active' } }, children: { some: partNotReady } },
    select: {
      id: true,
      chainStepTypeIds: true,
      workflowVersion: { select: { steps: { select: { id: true, stepTypeId: true, priced: true, position: true } } } },
    },
  });
  // The first step of the group's path, as a move works it out (`pathFor` with the group's chain).
  const firstStep = new Map<string, string>();
  for (const group of waiting) {
    const [first] = pathFor(group.workflowVersion.steps, group.chainStepTypeIds as string[] | null);
    if (first) firstStep.set(group.id, first);
  }
  const forParts = [...firstStep].map(([groupId, stepId]) => ({ groupId, currentStepId: stepId }));
  return {
    held: { status: 'active', OR: [{ group: waitingForPayment }, ...forParts] },
    async reasons(pieces) {
      const active = pieces.filter((piece) => piece.status === 'active');
      const unpaid = await waitingGroupIds(tx, [...new Set(active.map((piece) => piece.groupId))]);
      const reasons = new Map<string, HoldReason>();
      for (const piece of active) {
        if (unpaid.has(piece.groupId)) reasons.set(piece.id, 'waiting_for_payment');
        else if (piece.currentStepId !== null && firstStep.get(piece.groupId) === piece.currentStepId) reasons.set(piece.id, 'waiting_for_parts');
      }
      return reasons;
    },
  };
}
