import { Prisma } from '../../generated/prisma/client';
import { partnerCost, pricesFor } from './partner-cost';

const decimal = (value: string) => new Prisma.Decimal(value);

describe('a job priced for a partner', () => {
  const workspace = new Map([
    ['casting', 'workspace casting'],
    ['polishing', 'workspace polishing'],
    ['plating', 'workspace plating'],
  ]);
  const partner = {
    partnerStepTypeIds: new Set(['casting', 'polishing']),
    prices: new Map([['casting', 'partner casting']]),
  };

  it("uses the partner's price for the partner's steps, and the workspace's for the workspace's own", () => {
    expect(pricesFor({ workspace, partner }, 'casting')).toBe('partner casting');
    expect(pricesFor({ workspace, partner }, 'plating')).toBe('workspace plating');
  });

  it("never falls back to the workspace's price for a partner step the partner hasn't priced", () => {
    expect(pricesFor({ workspace, partner }, 'polishing')).toBeNull();
  });

  it('uses only the workspace prices without a partner, as quotes always have', () => {
    expect(pricesFor({ workspace }, 'casting')).toBe('workspace casting');
    expect(pricesFor({ workspace }, 'engraving')).toBeNull();
  });

  it("sums only the partner's steps, for the whole job, rounded to cents", () => {
    const steps = [
      { key: 'casting', cost: { cost: decimal('12.3456789') } },
      { key: 'polishing', cost: { cost: decimal('3.5') } },
      { key: 'plating', cost: { cost: decimal('100') } },
    ];
    // (12.3456789 + 3.5) × 10 = 158.456789
    expect(partnerCost(steps, new Set(['casting', 'polishing']), 10).toFixed()).toBe('158.46');
    expect(partnerCost(steps, new Set(), 10).toFixed()).toBe('0');
  });
});
