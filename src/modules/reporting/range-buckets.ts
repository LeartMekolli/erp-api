import { z } from 'zod';
import { MAX_RANGE_DAYS, spanDays, withinMaxRange } from './exports/export-kinds';
import { addDays } from './week-metrics';

// Splitting a date range into the buckets a dashboard chart draws: pure functions over `YYYY-MM-DD`
// strings, so a daylight-saving day is just one more calendar day.

export const BUCKETS = ['day', 'week', 'month'] as const;
export type Bucket = (typeof BUCKETS)[number];

/** A range of calendar dates, both ends included, up to a year; a caller may only ask for daily buckets. */
export const rangeQuerySchema = z
  .strictObject({ from: z.iso.date(), to: z.iso.date(), bucket: z.literal('day').optional() })
  .refine((range) => range.to >= range.from, { message: '`to` is before `from`', path: ['to'] })
  .refine(withinMaxRange, { message: `At most ${MAX_RANGE_DAYS} days`, path: ['to'] });
export type RangeQuery = z.infer<typeof rangeQuerySchema>;

interface DateRange {
  from: string;
  to: string;
}

/** The same number of days as `range`, ending the day before it starts. */
export function previousRange(range: DateRange): DateRange {
  const days = spanDays(range);
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

/** Days up to a month draw by day, up to about half a year by week, beyond that by month. */
export function pickBucket(range: DateRange, override?: 'day'): Bucket {
  if (override) return override;
  const days = spanDays(range);
  if (days <= 31) return 'day';
  if (days <= 183) return 'week';
  return 'month';
}

/** A run of days: the first date and how many days it holds. */
export interface BucketSpan {
  start: string;
  days: number;
}

/** The first day of the month after the one `date` is in. */
function nextMonthStart(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

/** The first day of the bucket after the one `date` is in. */
function nextBucketStart(date: string, bucket: Bucket): string {
  if (bucket === 'day') return addDays(date, 1);
  if (bucket === 'month') return nextMonthStart(date);
  // 0 is Sunday; ISO weeks start on Monday.
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, 7 - ((weekday + 6) % 7));
}

/** Calendar buckets (ISO weeks, calendar months) clipped to the range, oldest first. */
export function bucketsFor(range: DateRange, bucket: Bucket): BucketSpan[] {
  const spans: BucketSpan[] = [];
  let start = range.from;
  while (start <= range.to) {
    const next = nextBucketStart(start, bucket);
    const end = next > addDays(range.to, 1) ? addDays(range.to, 1) : next;
    spans.push({ start, days: spanDays({ from: start, to: addDays(end, -1) }) });
    start = next;
  }
  return spans;
}

/** The same span `byDays` days earlier. */
export function shiftBack(span: BucketSpan, byDays: number): BucketSpan {
  return { start: addDays(span.start, -byDays), days: span.days };
}

/** One value per span: the per-day values of its dates added up, a day without one counting as `empty()`. */
export function foldDays<T>(spans: BucketSpan[], perDay: Map<string, T>, empty: () => T, add: (a: T, b: T) => T): T[] {
  return spans.map((span) => {
    let total = empty();
    for (let offset = 0; offset < span.days; offset++) {
      total = add(total, perDay.get(addDays(span.start, offset)) ?? empty());
    }
    return total;
  });
}

/** Every date in the range, oldest first. */
export function localDays(range: DateRange): string[] {
  const days: string[] = [];
  for (let date = range.from; date <= range.to; date = addDays(date, 1)) days.push(date);
  return days;
}
