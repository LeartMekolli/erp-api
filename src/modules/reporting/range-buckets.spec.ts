import { bucketsFor, foldDays, localDays, pickBucket, previousRange, rangeQuerySchema, shiftBack } from './range-buckets';
import { addDays } from './week-metrics';

const rangeOf = (days: number) => ({ from: '2026-01-01', to: addDays('2026-01-01', days - 1) });

describe('range buckets', () => {
  it('picks day up to 31 days, week up to 183, month beyond, and honours a day override', () => {
    expect(pickBucket(rangeOf(31))).toBe('day');
    expect(pickBucket(rangeOf(32))).toBe('week');
    expect(pickBucket(rangeOf(183))).toBe('week');
    expect(pickBucket(rangeOf(184))).toBe('month');
    expect(pickBucket(rangeOf(184), 'day')).toBe('day');
  });

  it('cuts weeks at Monday and clips the first and last to the range', () => {
    const spans = bucketsFor({ from: '2026-01-15', to: '2026-03-10' }, 'week');
    expect(spans[0]).toEqual({ start: '2026-01-15', days: 4 });
    expect(spans[1]).toEqual({ start: '2026-01-19', days: 7 });
    expect(spans[spans.length - 1]).toEqual({ start: '2026-03-09', days: 2 });
    expect(spans.reduce((sum, span) => sum + span.days, 0)).toBe(55);
  });

  it('cuts months at the first and clips the first and last to the range', () => {
    expect(bucketsFor({ from: '2026-01-15', to: '2026-04-02' }, 'month')).toEqual([
      { start: '2026-01-15', days: 17 },
      { start: '2026-02-01', days: 28 },
      { start: '2026-03-01', days: 31 },
      { start: '2026-04-01', days: 2 },
    ]);
  });

  it('crosses a year end in month buckets', () => {
    expect(bucketsFor({ from: '2026-12-20', to: '2027-01-05' }, 'month')).toEqual([
      { start: '2026-12-20', days: 12 },
      { start: '2027-01-01', days: 5 },
    ]);
  });

  it('gives one bucket per day', () => {
    expect(bucketsFor({ from: '2026-03-01', to: '2026-03-03' }, 'day')).toEqual([
      { start: '2026-03-01', days: 1 },
      { start: '2026-03-02', days: 1 },
      { start: '2026-03-03', days: 1 },
    ]);
  });

  it('takes the period of the same length just before a range', () => {
    expect(previousRange({ from: '2026-03-01', to: '2026-03-31' })).toEqual({ from: '2026-01-29', to: '2026-02-28' });
  });

  it('shifts a span back, keeping its length', () => {
    expect(shiftBack({ start: '2026-03-01', days: 7 }, 31)).toEqual({ start: '2026-01-29', days: 7 });
  });

  it('lists calendar dates, so a daylight-saving day is still one day', () => {
    expect(localDays({ from: '2026-03-28', to: '2026-03-30' })).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
  });

  it('adds up each span from its days, an empty value for a missing day', () => {
    const perDay = new Map([
      ['2026-03-01', 2],
      ['2026-03-03', 5],
    ]);
    const spans = [
      { start: '2026-03-01', days: 3 },
      { start: '2026-03-04', days: 2 },
    ];
    expect(foldDays(spans, perDay, () => 0, (a, b) => a + b)).toEqual([7, 0]);
  });

  describe('range query', () => {
    it('takes a range with or without the day bucket', () => {
      expect(rangeQuerySchema.safeParse({ from: '2026-03-01', to: '2026-03-31' }).success).toBe(true);
      expect(rangeQuerySchema.safeParse({ from: '2026-03-01', to: '2026-03-31', bucket: 'day' }).success).toBe(true);
    });

    it('refuses to before from, more than 366 days, a bad date and a bucket other than day', () => {
      expect(rangeQuerySchema.safeParse({ from: '2026-03-02', to: '2026-03-01' }).success).toBe(false);
      expect(rangeQuerySchema.safeParse({ from: '2026-01-01', to: '2027-01-02' }).success).toBe(false);
      expect(rangeQuerySchema.safeParse({ from: '2026-13-01', to: '2026-03-01' }).success).toBe(false);
      expect(rangeQuerySchema.safeParse({ from: '2026-03-01', to: '2026-03-31', bucket: 'week' }).success).toBe(false);
    });

    it('accepts 366 days exactly', () => {
      expect(rangeQuerySchema.safeParse({ from: '2026-01-01', to: '2027-01-01' }).success).toBe(true);
    });
  });
});
