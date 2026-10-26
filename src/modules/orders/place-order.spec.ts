import { Prisma } from '../../generated/prisma/client';
import { DEFAULT_CALENDAR, commonSpeed, orderTotals } from './place-order';

describe('placing an order', () => {
  const decimal = (value: string) => new Prisma.Decimal(value);

  it('adds the lines, the shipping and the tax into the total', () => {
    const totals = orderTotals([decimal('120.00'), decimal('35.50')], decimal('9.90'), decimal('31.43'));
    expect(totals.linesTotal.toFixed(2)).toBe('155.50');
    expect(totals.total.toFixed(2)).toBe('196.83');
  });

  it('totals a single line with free shipping and no tax', () => {
    const totals = orderTotals([decimal('165.01')], decimal('0'), decimal('0'));
    expect(totals.linesTotal.toFixed(2)).toBe('165.01');
    expect(totals.total.toFixed(2)).toBe('165.01');
  });

  it('takes the one delivery speed every line was priced at', () => {
    expect(commonSpeed(['standard', 'standard'])).toEqual({ ok: true, speed: 'standard' });
    expect(commonSpeed([null, null])).toEqual({ ok: true, speed: null });
  });

  it('refuses lines priced at different delivery speeds', () => {
    expect(commonSpeed(['standard', 'rush'])).toEqual({ ok: false });
    expect(commonSpeed(['standard', null])).toEqual({ ok: false });
  });

  it('falls back to Monday to Friday, closing at 17:00, for a workspace without a calendar', () => {
    expect(DEFAULT_CALENDAR).toEqual({ workingDays: [1, 2, 3, 4, 5], endHour: 17, closedDates: [] });
  });
});
