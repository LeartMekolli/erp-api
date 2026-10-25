import { Prisma } from '../../generated/prisma/client';
import { owedFor, passedPayout } from './owed';

const decimal = (value: string) => new Prisma.Decimal(value);

describe('a piece past the payout step', () => {
  // The cast line: polishing at 40, final QC (the payout step) at 90, packing at 95.
  const payoutPosition = 90;

  it('is past it once it is at a later step, or finished', () => {
    expect(passedPayout({ status: 'active', stepPosition: 95 }, payoutPosition)).toBe(true);
    expect(passedPayout({ status: 'finished', stepPosition: null }, payoutPosition)).toBe(true);
  });

  it('is not past it while at the payout step or before it, such as after a correction back to polishing', () => {
    expect(passedPayout({ status: 'active', stepPosition: 90 }, payoutPosition)).toBe(false);
    expect(passedPayout({ status: 'active', stepPosition: 40 }, payoutPosition)).toBe(false);
  });

  it('never counts a scrapped or cancelled piece as past it', () => {
    expect(passedPayout({ status: 'scrapped', stepPosition: null }, payoutPosition)).toBe(false);
    expect(passedPayout({ status: 'cancelled', stepPosition: null }, payoutPosition)).toBe(false);
  });
});

describe('what a partner is owed for a job', () => {
  const accepted = { status: 'accepted', cost: decimal('152.40'), owedOverride: null };
  const passed = (count: number) => Array.from({ length: count }, () => ({ status: 'active', passedPayout: true }));

  it('owes nothing yet while one live piece is before the payout step, and says what it will be', () => {
    const owed = owedFor(accepted, [...passed(9), { status: 'active', passedPayout: false }]);
    expect(owed).toEqual({ state: 'not_yet', amount: decimal('152.40') });
  });

  it('owes the frozen cost once every live piece has passed the payout step', () => {
    const owed = owedFor(accepted, [...passed(8), { status: 'finished', passedPayout: true }, { status: 'finished', passedPayout: true }]);
    expect(owed).toEqual({ state: 'owed', amount: decimal('152.40') });
  });

  it('owes the same amount when a scrapped piece was remade and its replacement passed', () => {
    const owed = owedFor(accepted, [...passed(9), { status: 'scrapped', passedPayout: false }, { status: 'active', passedPayout: true }]);
    expect(owed).toEqual({ state: 'owed', amount: decimal('152.40') });
  });

  it('ignores a cancelled piece, but not a remade one still before the payout step', () => {
    expect(owedFor(accepted, [...passed(10), { status: 'cancelled', passedPayout: false }])?.state).toBe('owed');
    expect(
      owedFor(accepted, [...passed(9), { status: 'scrapped', passedPayout: false }, { status: 'active', passedPayout: false }])?.state,
    ).toBe('not_yet');
  });

  it('owes nothing yet for a job with no live piece', () => {
    expect(owedFor(accepted, [{ status: 'cancelled', passedPayout: false }])?.state).toBe('not_yet');
  });

  it("owes the amount staff set instead of the cost, once it's due", () => {
    const overridden = { ...accepted, owedOverride: decimal('180.00') };
    expect(owedFor(overridden, passed(10))).toEqual({ state: 'owed', amount: decimal('180.00') });
    expect(owedFor(overridden, [{ status: 'active', passedPayout: false }])).toEqual({ state: 'not_yet', amount: decimal('180.00') });
  });

  it('owes a replaced partner the amount staff set at once, whatever the pieces, and nothing without one', () => {
    const before = [{ status: 'active', passedPayout: false }];
    expect(owedFor({ status: 'replaced', cost: decimal('152.40'), owedOverride: decimal('40.00') }, before)).toEqual({
      state: 'owed',
      amount: decimal('40.00'),
    });
    expect(owedFor({ status: 'replaced', cost: decimal('152.40'), owedOverride: null }, before)).toEqual({
      state: 'owed',
      amount: decimal('0'),
    });
  });

  it('owes nothing for an offer that was never accepted', () => {
    for (const status of ['offered', 'declined', 'expired', 'withdrawn']) {
      expect(owedFor({ ...accepted, status }, passed(10))).toBeNull();
    }
  });
});
