import { Prisma } from '../../generated/prisma/client';
import { overLimit } from './credit';

const d = (value: string) => new Prisma.Decimal(value);

describe('overLimit', () => {
  it('lets an order reach the limit exactly, and holds one a cent past it', () => {
    expect(overLimit(d('4500.00'), d('500.00'), d('5000.00'))).toBe(false);
    expect(overLimit(d('4500.00'), d('500.01'), d('5000.00'))).toBe(true);
  });

  it('holds any order once the exposure alone is past the limit', () => {
    expect(overLimit(d('5500.00'), d('0.01'), d('5000.00'))).toBe(true);
  });

  it('never holds an order of a customer without a limit', () => {
    expect(overLimit(d('1000000.00'), d('500.00'), null)).toBe(false);
  });
});
