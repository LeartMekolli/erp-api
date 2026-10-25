import { Prisma } from '../../generated/prisma/client';

/**
 * What a partner is owed for a job (Partners spec, goal 14; P10, P16), derived on read from the job's
 * assignment and where its pieces are now, so it stays right after a correction.
 */

export type OwedState = 'not_yet' | 'owed';

export interface Owed {
  state: OwedState;
  /** What is owed, or will be once the job is owed. */
  amount: Prisma.Decimal;
}

/** Pieces still to make or made; scrapped and cancelled ones are replaced or gone. */
const LIVE = new Set(['active', 'finished']);

/**
 * The piece has passed the payout step: it is finished, or at a step after it. A correction back to
 * the payout step or before it takes that away until the piece passes again.
 */
export function passedPayout(piece: { status: string; stepPosition: number | null }, payoutPosition: number): boolean {
  if (piece.status === 'finished') return true;
  return piece.status === 'active' && piece.stepPosition !== null && piece.stepPosition > payoutPosition;
}

/**
 * An accepted job is owed once every live piece has passed the payout step: the cost frozen when it was
 * handed over, or what staff set instead. Remaking a scrapped piece is the partner's own cost, so the
 * amount never changes. A partner replaced mid-way is owed what staff set, at once. Anything else: nothing.
 */
export function owedFor(
  assignment: { status: string; cost: Prisma.Decimal; owedOverride: Prisma.Decimal | null },
  pieces: { status: string; passedPayout: boolean }[],
): Owed | null {
  if (assignment.status === 'replaced') {
    return { state: 'owed', amount: assignment.owedOverride ?? new Prisma.Decimal(0) };
  }
  if (assignment.status !== 'accepted') return null;
  const live = pieces.filter((piece) => LIVE.has(piece.status));
  const done = live.length > 0 && live.every((piece) => piece.passedPayout);
  return { state: done ? 'owed' : 'not_yet', amount: assignment.owedOverride ?? assignment.cost };
}
