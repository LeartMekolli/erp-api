import { Prisma } from '../../../generated/prisma/client';
import { bandFor, percentileParts, scoreOf } from './score';
import type { History } from './score';

const d = (value: string) => new Prisma.Decimal(value);
const history = (customerId: string, extra: Partial<History> = {}): History => ({
  customerId,
  lifetime: d('0'),
  recent: d('0'),
  orders365: 1,
  invoicesDue: 0,
  invoicesOnTime: 0,
  ...extra,
});

describe('priority score', () => {
  it('ranks each part against the other customers, ties sharing their place and the best at 100', () => {
    const parts = percentileParts([
      history('luna', { lifetime: d('100'), recent: d('10'), orders365: 2 }),
      history('mare', { lifetime: d('100'), recent: d('30'), orders365: 1 }),
      history('sol', { lifetime: d('300'), recent: d('20'), orders365: 9 }),
    ]);

    expect(parts.get('luna')).toMatchObject({ lifetime: 25, recent: 0, frequency: 50 });
    expect(parts.get('mare')).toMatchObject({ lifetime: 25, recent: 100, frequency: 0 });
    expect(parts.get('sol')).toMatchObject({ lifetime: 100, recent: 50, frequency: 100 });
  });

  it('gives a customer alone 100 everywhere', () => {
    expect(percentileParts([history('luna', { lifetime: d('5') })]).get('luna')).toEqual({ lifetime: 100, recent: 100, frequency: 100, payment: 100 });
  });

  it('counts a customer with no invoices yet as paying on time', () => {
    const parts = percentileParts([
      history('new', { invoicesDue: 0, invoicesOnTime: 0 }),
      history('late', { invoicesDue: 4, invoicesOnTime: 1 }),
      history('punctual', { invoicesDue: 2, invoicesOnTime: 2 }),
    ]);

    expect(parts.get('new')?.payment).toBe(75);
    expect(parts.get('punctual')?.payment).toBe(75);
    expect(parts.get('late')?.payment).toBe(0);
  });

  it('leaves out a customer without an order in the last 365 days', () => {
    const parts = percentileParts([history('luna', { lifetime: d('100') }), history('gone', { lifetime: d('900'), orders365: 0 })]);

    expect(parts.has('gone')).toBe(false);
    expect(parts.get('luna')?.lifetime).toBe(100);
  });

  it('weighs the parts into a score from 0 to 100', () => {
    expect(scoreOf({ lifetime: 100, recent: 50, frequency: 0, payment: 100 }, { lifetime: 2, recent: 1, frequency: 1, payment: 0 })).toBe(63);
    expect(scoreOf({ lifetime: 100, recent: 100, frequency: 100, payment: 100 }, { lifetime: 0, recent: 0, frequency: 0, payment: 0 })).toBe(0);
  });

  it('puts a score in the band with the highest start at or below it, else none', () => {
    const bands = [
      { key: 'silver', from: 50 },
      { key: 'gold', from: 80 },
    ];

    expect(bandFor(80, bands)).toBe('gold');
    expect(bandFor(79, bands)).toBe('silver');
    expect(bandFor(10, bands)).toBeNull();
    expect(bandFor(100, [])).toBeNull();
  });
});
