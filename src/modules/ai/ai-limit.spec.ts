import { Prisma } from '../../generated/prisma/client';
import { monthBounds, noticeLevel } from './ai-limit';

const usd = (value: string) => new Prisma.Decimal(value);

describe('monthBounds', () => {
  it('is the UTC calendar month, whatever the local time', () => {
    expect(monthBounds(new Date('2026-10-31T23:30:00Z'))).toEqual({
      start: new Date('2026-10-01T00:00:00Z'),
      end: new Date('2026-11-01T00:00:00Z'),
      key: '2026-10',
    });
  });

  it('starts a month at its first millisecond and crosses the year', () => {
    expect(monthBounds(new Date('2026-12-01T00:00:00Z'))).toEqual({
      start: new Date('2026-12-01T00:00:00Z'),
      end: new Date('2027-01-01T00:00:00Z'),
      key: '2026-12',
    });
  });
});

describe('noticeLevel', () => {
  it.each([
    ['10', '20', null],
    ['15.99', '20', null],
    ['16', '20', 80],
    ['19.99', '20', 80],
    ['20', '20', 100],
    ['25', '20', 100],
  ])('spent %s of %s → %s', (spent, limit, level) => {
    expect(noticeLevel(usd(spent), usd(limit))).toBe(level);
  });

  it('treats a limit of zero as used', () => {
    expect(noticeLevel(usd('0'), usd('0'))).toBe(100);
  });
});
