import { Prisma } from '../../generated/prisma/client';
import { dueFor, payoutLines } from './payouts';

const d = (value: string) => new Prisma.Decimal(value);

describe('dueFor', () => {
  it('is what is owed while nothing is paid', () => {
    expect(dueFor(d('300.00'), d('0')).toFixed(2)).toBe('300.00');
  });

  it('is the rest once staff raise what is owed after a payout', () => {
    expect(dueFor(d('350.00'), d('300.00')).toFixed(2)).toBe('50.00');
  });

  it('takes back what was paid for a job no longer owed', () => {
    expect(dueFor(null, d('300.00')).toFixed(2)).toBe('-300.00');
  });
});

describe('payoutLines', () => {
  it('keeps every job with something due either way, and leaves out the settled ones', () => {
    const { lines, total } = payoutLines([
      { assignmentId: 'a', due: d('50.00') },
      { assignmentId: 'b', due: d('0.00') },
      { assignmentId: 'c', due: d('-300.00') },
    ]);
    expect(lines.map((line) => [line.assignmentId, line.amount.toFixed(2)])).toEqual([
      ['a', '50.00'],
      ['c', '-300.00'],
    ]);
    // Less than nothing: nothing to pay.
    expect(total.toFixed(2)).toBe('-250.00');
  });

  it('adds up what is due across jobs', () => {
    const { total } = payoutLines([
      { assignmentId: 'a', due: d('120.00') },
      { assignmentId: 'b', due: d('30.50') },
    ]);
    expect(total.toFixed(2)).toBe('150.50');
  });
});
