import { owedAt, partnerDoneAt } from './owed-dates';
import type { PieceMoveFact } from './owed-dates';

const day = (n: number) => new Date(`2026-11-${String(n).padStart(2, '0')}T10:00:00Z`);

describe('the day a job became owed', () => {
  // The cast line: polishing at 40, final QC (the payout step) at 90, packing at 95.
  const payoutPosition = 90;
  const pass = (workOrderId: string, n: number): PieceMoveFact => ({
    workOrderId,
    at: day(n),
    fromPosition: 90,
    toPosition: 95,
    fromStatus: 'active',
    toStatus: 'active',
  });
  const polish = (workOrderId: string, n: number): PieceMoveFact => ({
    workOrderId,
    at: day(n),
    fromPosition: 40,
    toPosition: 90,
    fromStatus: 'active',
    toStatus: 'active',
  });
  const correctBack = (workOrderId: string, n: number): PieceMoveFact => ({
    workOrderId,
    at: day(n),
    fromPosition: 95,
    toPosition: 40,
    fromStatus: 'active',
    toStatus: 'active',
  });
  const scrap = (workOrderId: string, n: number): PieceMoveFact => ({
    workOrderId,
    at: day(n),
    fromPosition: 40,
    toPosition: null,
    fromStatus: 'active',
    toStatus: 'scrapped',
  });

  it('is the day the last live piece passed the payout step', () => {
    const pieces = [
      { id: 'a', status: 'active', passedPayout: true },
      { id: 'b', status: 'active', passedPayout: true },
    ];
    expect(owedAt(pieces, [polish('a', 1), pass('a', 1), polish('b', 2), pass('b', 3)], payoutPosition)).toEqual(day(3));
  });

  it('is the day a piece was scrapped without a remake, when that left every live piece past it', () => {
    const pieces = [
      { id: 'a', status: 'active', passedPayout: true },
      { id: 'b', status: 'scrapped', passedPayout: false },
    ];
    expect(owedAt(pieces, [pass('a', 1), scrap('b', 3)], payoutPosition)).toEqual(day(3));
  });

  it('has no day while a piece corrected back before the payout step has not passed again', () => {
    const pieces = [
      { id: 'a', status: 'active', passedPayout: false },
      { id: 'b', status: 'active', passedPayout: true },
    ];
    expect(owedAt(pieces, [pass('a', 1), pass('b', 2), correctBack('a', 4)], payoutPosition)).toBeNull();
  });

  it('is the day the corrected piece passed again', () => {
    const pieces = [
      { id: 'a', status: 'active', passedPayout: true },
      { id: 'b', status: 'active', passedPayout: true },
    ];
    const moves = [pass('a', 1), pass('b', 2), correctBack('a', 4), polish('a', 5), pass('a', 6)];
    expect(owedAt(pieces, moves, payoutPosition)).toEqual(day(6));
  });

  it('counts only moves to finished when the version has no partner steps', () => {
    const pieces = [{ id: 'a', status: 'finished', passedPayout: true }];
    const moves: PieceMoveFact[] = [
      { workOrderId: 'a', at: day(1), fromPosition: 10, toPosition: 20, fromStatus: 'active', toStatus: 'active' },
      { workOrderId: 'a', at: day(2), fromPosition: 20, toPosition: null, fromStatus: 'active', toStatus: 'finished' },
    ];
    expect(owedAt(pieces, moves, Number.POSITIVE_INFINITY)).toEqual(day(2));
  });

  it('has no day for a job with no live piece', () => {
    expect(owedAt([{ id: 'a', status: 'cancelled', passedPayout: false }], [], payoutPosition)).toBeNull();
  });
});

describe("the day the partner's part of a job ended", () => {
  // Partner steps at 10 and 20; the workspace's own QC at 30 and packing at 40.
  const lastPartnerPosition = 20;

  it('is the last move off a partner step, not a later one between two workspace steps', () => {
    const moves: PieceMoveFact[] = [
      { workOrderId: 'a', at: day(1), fromPosition: 10, toPosition: 20, fromStatus: 'active', toStatus: 'active' },
      { workOrderId: 'a', at: day(2), fromPosition: 20, toPosition: 30, fromStatus: 'active', toStatus: 'active' },
      { workOrderId: 'a', at: day(5), fromPosition: 30, toPosition: 40, fromStatus: 'active', toStatus: 'active' },
    ];
    expect(partnerDoneAt(moves, lastPartnerPosition)).toEqual(day(2));
  });

  it('is none without a move off a partner step', () => {
    const moves: PieceMoveFact[] = [
      { workOrderId: 'a', at: day(5), fromPosition: 30, toPosition: 40, fromStatus: 'active', toStatus: 'active' },
    ];
    expect(partnerDoneAt(moves, lastPartnerPosition)).toBeNull();
  });
});
