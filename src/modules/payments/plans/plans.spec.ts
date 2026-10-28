import { Prisma } from '../../../generated/prisma/client';
import { isUpgrade, monthlyEquivalent } from './plans';

const price = (amount: string, interval: 'month' | 'year') => ({ amount: new Prisma.Decimal(amount), interval });

describe('monthlyEquivalent', () => {
  it('is the amount for a monthly price', () => {
    expect(monthlyEquivalent(price('29.00', 'month')).toFixed(2)).toBe('29.00');
  });

  it('is a twelfth of a yearly price, not rounded', () => {
    expect(monthlyEquivalent(price('120.00', 'year')).toFixed(2)).toBe('10.00');
    expect(monthlyEquivalent(price('290.00', 'year')).toFixed(4)).toBe('24.1667');
  });
});

describe('isUpgrade', () => {
  it('is an upgrade to a dearer plan', () => {
    expect(isUpgrade(price('29.00', 'month'), price('99.00', 'month'))).toBe(true);
  });

  it('compares by the monthly price, so yearly Pro to monthly Business is an upgrade', () => {
    expect(isUpgrade(price('290.00', 'year'), price('99.00', 'month'))).toBe(true);
    expect(isUpgrade(price('290.00', 'year'), price('29.00', 'month'))).toBe(true);
  });

  it('is a downgrade to a cheaper price per month, such as monthly to yearly on one plan', () => {
    expect(isUpgrade(price('29.00', 'month'), price('290.00', 'year'))).toBe(false);
    expect(isUpgrade(price('99.00', 'month'), price('29.00', 'month'))).toBe(false);
  });

  it('counts the same price per month as an upgrade', () => {
    expect(isUpgrade(price('29.00', 'month'), price('29.00', 'month'))).toBe(true);
  });
});
