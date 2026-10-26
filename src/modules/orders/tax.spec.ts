import { Prisma } from '../../generated/prisma/client';
import { pickRate, taxAmount } from './tax';

describe('tax', () => {
  const rate = (country: string | null, region: string | null, percent: string) => ({
    country,
    region,
    percent: new Prisma.Decimal(percent),
  });
  const rates = [rate(null, null, '5'), rate('DE', null, '19'), rate('DE', 'BY', '17'), rate('AT', null, '20')];

  it("takes the region's rate over the country's, and the country's over the default", () => {
    expect(pickRate(rates, { country: 'DE', region: 'BY' }).toFixed()).toBe('17');
    expect(pickRate(rates, { country: 'DE', region: 'BE' }).toFixed()).toBe('19');
    expect(pickRate(rates, { country: 'DE', region: null }).toFixed()).toBe('19');
    expect(pickRate(rates, { country: 'FR', region: null }).toFixed()).toBe('5');
  });

  it('taxes at 0 when the workspace has no rates at all', () => {
    expect(pickRate([], { country: 'DE', region: null }).toFixed()).toBe('0');
    expect(pickRate([rate('AT', null, '20')], { country: 'DE', region: null }).toFixed()).toBe('0');
  });

  it('taxes the lines and the shipping together, rounded half-up to cents once', () => {
    expect(taxAmount(new Prisma.Decimal('20'), new Prisma.Decimal('100.00'), new Prisma.Decimal('9.99')).toFixed(2)).toBe('22.00');
    expect(taxAmount(new Prisma.Decimal('7.7'), new Prisma.Decimal('10.00'), new Prisma.Decimal('0')).toFixed(2)).toBe('0.77');
    // 19 % of 0.50 is 0.095: half-up gives 0.10.
    expect(taxAmount(new Prisma.Decimal('19'), new Prisma.Decimal('0.50'), new Prisma.Decimal('0')).toFixed(2)).toBe('0.10');
    expect(taxAmount(new Prisma.Decimal('0'), new Prisma.Decimal('155.50'), new Prisma.Decimal('9.90')).toFixed(2)).toBe('0.00');
  });
});
