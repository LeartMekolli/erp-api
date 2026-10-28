import { takeFrom } from './credit-ledger';

const day = (n: number) => new Date(Date.UTC(2026, 10, 1 + n));

describe('takeFrom', () => {
  const grants = [
    { id: 'campaign', source: 'campaign' as const, grantedAt: day(0), expiresAt: day(5), remaining: 10 },
    { id: 'allowance', source: 'allowance' as const, grantedAt: day(0), expiresAt: day(30), remaining: 50 },
    { id: 'pack', source: 'pack' as const, grantedAt: day(0), expiresAt: day(360), remaining: 100 },
    { id: 'staff', source: 'staff' as const, grantedAt: day(0), expiresAt: day(3), remaining: 5 },
  ];

  it('takes promo and staff grants first, then the allowance, then packs, each by the earliest expiry', () => {
    expect(takeFrom(grants, 20)).toEqual([
      { grantId: 'staff', amount: 5 },
      { grantId: 'campaign', amount: 10 },
      { grantId: 'allowance', amount: 5 },
    ]);
  });

  it('reaches packs only once the allowance is used up', () => {
    expect(takeFrom(grants, 70)).toEqual([
      { grantId: 'staff', amount: 5 },
      { grantId: 'campaign', amount: 10 },
      { grantId: 'allowance', amount: 50 },
      { grantId: 'pack', amount: 5 },
    ]);
  });

  it('takes every credit when the amount is exactly the total', () => {
    expect(takeFrom(grants, 165)?.reduce((sum, part) => sum + part.amount, 0)).toBe(165);
  });

  it('refuses when the remaining total is short', () => {
    expect(takeFrom(grants, 166)).toBeNull();
  });

  it('takes the older of two packs with the same expiry first, and skips grants with nothing left', () => {
    const packs = [
      { id: 'newer', source: 'pack' as const, grantedAt: day(2), expiresAt: day(400), remaining: 10 },
      { id: 'empty', source: 'pack' as const, grantedAt: day(0), expiresAt: day(100), remaining: 0 },
      { id: 'older', source: 'pack' as const, grantedAt: day(1), expiresAt: day(400), remaining: 10 },
    ];

    expect(takeFrom(packs, 15)).toEqual([
      { grantId: 'older', amount: 10 },
      { grantId: 'newer', amount: 5 },
    ]);
  });
});
