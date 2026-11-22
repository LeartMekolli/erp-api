import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { localDate, startOfLocalDay } from '../orders/dates';
import { owedBetween } from '../partners/owed-dates';
import { groupReady } from '../workflow/progress';
import { addDays, onTimeCounts } from './week-metrics';

// The dashboard's numbers per local day (dashboard data spec, "What a point counts"): each loader counts
// the rows `metricsFor` counts, with the same filters, grouped by the day in the workspace's time zone.
// Points add the days of a bucket up and divide only then, never averaging rates.

type Tx = Prisma.TransactionClient;

const money = z.string().regex(/^-?\d+\.\d{2}$/);
const rate = z.number().min(0).max(1);

/** One bucket's numbers; money and partner cost are left out for a reader who may not see them. */
export const seriesPointSchema = z.strictObject({
  orders_placed: z.number().int().min(0),
  revenue: money.optional(),
  average_value: money.nullable().optional(),
  on_time_rate: rate.nullable(),
  defect_rate: rate.nullable(),
  partner_cost: money.optional(),
});
export type SeriesPoint = z.infer<typeof seriesPointSchema>;

/**
 * A bucket: its first day inside the range, how many of its days are inside it, its numbers, and those of
 * the same days one range earlier.
 */
export const seriesEntrySchema = seriesPointSchema.extend({
  start: z.iso.date(),
  days: z.number().int().min(1),
  previous: seriesPointSchema,
});
export type SeriesEntry = z.infer<typeof seriesEntrySchema>;

/** Calendar dates in `timeZone`, both ends included, and what money is counted in. */
export interface DailySpan {
  from: string;
  to: string;
  timeZone: string;
  currency: string;
}

/** A group's pieces, each with when it finished, if it has. */
export const PIECES_WITH_FINISH = {
  select: {
    status: true,
    transitions: { where: { toStatus: 'finished' }, select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
  },
} as const;

/** The day the last piece of a group finished, once every live piece has; null before. */
export function readyOn(pieces: { status: string; transitions: { createdAt: Date }[] }[], timeZone: string): string | null {
  if (!groupReady(pieces)) return null;
  const finished = pieces.flatMap((piece) => piece.transitions.map((move) => move.createdAt.getTime()));
  if (finished.length === 0) return null;
  return localDate(new Date(Math.max(...finished)), timeZone);
}

/** The instants the span's dates begin and end. */
function instants(span: DailySpan): { from: Date; to: Date } {
  return { from: startOfLocalDay(span.from, span.timeZone), to: startOfLocalDay(addDays(span.to, 1), span.timeZone) };
}

/**
 * An instant as the `timestamp(3)` columns hold it: UTC wall time without a zone. Sent as text, so the
 * session's time zone plays no part.
 */
const asColumn = (instant: Date) => Prisma.sql`(${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** The local date, as `YYYY-MM-DD`, of a `timestamp(3)` column holding UTC. */
const localDay = (column: Prisma.Sql, timeZone: string) =>
  Prisma.sql`to_char(((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}::text)::date, 'YYYY-MM-DD')`;

/** Orders placed and not cancelled, as `compute` counts them: revenue and `priced` only in `currency`. */
export interface DayOrders {
  placed: number;
  revenue: Prisma.Decimal;
  priced: number;
}

export async function dailyOrders(tx: Tx, span: DailySpan): Promise<Map<string, DayOrders>> {
  const { from, to } = instants(span);
  const rows = await tx.$queryRaw<{ day: string; placed: number; revenue: string; priced: number }[]>`
    SELECT ${localDay(Prisma.sql`placed_at`, span.timeZone)} AS day,
           count(*)::int AS placed,
           coalesce(sum(total - tax_amount) FILTER (WHERE currency = ${span.currency}::text), 0)::text AS revenue,
           count(*) FILTER (WHERE currency = ${span.currency}::text)::int AS priced
    FROM "order"
    WHERE cancelled_at IS NULL AND placed_at >= ${asColumn(from)} AND placed_at < ${asColumn(to)}
    GROUP BY 1`;
  return new Map(rows.map((row) => [row.day, { placed: row.placed, revenue: new Prisma.Decimal(row.revenue), priced: row.priced }]));
}

/**
 * Order lines by their order's promised date, as `onTime` counts them: how many were due, judged at
 * `today`, and how many of those were ready by that date.
 */
export async function dailyOnTime(tx: Tx, span: DailySpan & { today: string }): Promise<Map<string, { due: number; onTime: number }>> {
  const lines = await tx.orderLine.findMany({
    where: {
      cancelledAt: null,
      order: { cancelledAt: null, promisedOn: { gte: new Date(`${span.from}T00:00:00Z`), lt: new Date(`${addDays(span.to, 1)}T00:00:00Z`) } },
    },
    select: { order: { select: { promisedOn: true } }, group: { select: { workOrders: PIECES_WITH_FINISH } } },
  });
  const byDay = new Map<string, { promisedOn: string; readyOn: string | null }[]>();
  for (const line of lines) {
    // A `@db.Date` column: its UTC date is the date.
    const promisedOn = line.order.promisedOn.toISOString().slice(0, 10);
    const entry = { promisedOn, readyOn: line.group ? readyOn(line.group.workOrders, span.timeZone) : null };
    byDay.set(promisedOn, [...(byDay.get(promisedOn) ?? []), entry]);
  }
  return new Map([...byDay].map(([day, dayLines]) => [day, onTimeCounts(dayLines, span.today)]));
}

/** QC moves (every inspected pass or fail), and those recording a defect, as `defectRate` counts them. */
export async function dailyDefects(tx: Tx, span: DailySpan): Promise<Map<string, { inspected: number; withDefect: number }>> {
  const { from, to } = instants(span);
  const rows = await tx.$queryRaw<{ day: string; inspected: number; with_defect: number }[]>`
    SELECT ${localDay(Prisma.sql`created_at`, span.timeZone)} AS day,
           count(*)::int AS inspected,
           count(*) FILTER (WHERE defect_id IS NOT NULL)::int AS with_defect
    FROM transition
    WHERE inspected AND kind IN ('pass', 'fail') AND created_at >= ${asColumn(from)} AND created_at < ${asColumn(to)}
    GROUP BY 1`;
  return new Map(rows.map((row) => [row.day, { inspected: row.inspected, withDefect: row.with_defect }]));
}

/** What partner jobs became owed, on the local day they did (`owedBetween`, as `partners.cost`). */
export async function dailyPartnerCost(tx: Tx, span: DailySpan): Promise<Map<string, Prisma.Decimal>> {
  const { from, to } = instants(span);
  const byDay = new Map<string, Prisma.Decimal>();
  for (const entry of await owedBetween(tx, from, to)) {
    const day = localDate(entry.at, span.timeZone);
    byDay.set(day, (byDay.get(day) ?? new Prisma.Decimal(0)).add(entry.amount));
  }
  return byDay;
}

/** Everything a point is worked out from, as sums, so days and buckets add up. */
export interface DayTotals {
  placed: number;
  revenue: Prisma.Decimal;
  priced: number;
  due: number;
  onTime: number;
  inspected: number;
  withDefect: number;
  partnerCost: Prisma.Decimal;
}

export const emptyTotals = (): DayTotals => ({
  placed: 0,
  revenue: new Prisma.Decimal(0),
  priced: 0,
  due: 0,
  onTime: 0,
  inspected: 0,
  withDefect: 0,
  partnerCost: new Prisma.Decimal(0),
});

export const addTotals = (a: DayTotals, b: DayTotals): DayTotals => ({
  placed: a.placed + b.placed,
  revenue: a.revenue.add(b.revenue),
  priced: a.priced + b.priced,
  due: a.due + b.due,
  onTime: a.onTime + b.onTime,
  inspected: a.inspected + b.inspected,
  withDefect: a.withDefect + b.withDefect,
  partnerCost: a.partnerCost.add(b.partnerCost),
});

/** Every day of the span with anything in it; one query per measure, whatever the span's length. */
export async function dailyTotals(tx: Tx, span: DailySpan & { today: string }): Promise<Map<string, DayTotals>> {
  const orders = await dailyOrders(tx, span);
  const onTime = await dailyOnTime(tx, span);
  const defects = await dailyDefects(tx, span);
  const cost = await dailyPartnerCost(tx, span);
  const days = new Map<string, DayTotals>();
  const at = (day: string) => {
    const totals = days.get(day) ?? emptyTotals();
    days.set(day, totals);
    return totals;
  };
  for (const [day, value] of orders) Object.assign(at(day), { placed: value.placed, revenue: value.revenue, priced: value.priced });
  for (const [day, value] of onTime) Object.assign(at(day), { due: value.due, onTime: value.onTime });
  for (const [day, value] of defects) Object.assign(at(day), { inspected: value.inspected, withDefect: value.withDefect });
  for (const [day, value] of cost) Object.assign(at(day), { partnerCost: value });
  return days;
}

/**
 * A bucket's point from its summed days: rates and the average from the sums. Without `payment.read` no
 * money, and partner cost only with `partner.read` as well; left out, never zeroed.
 */
export function pointOf(totals: DayTotals, may: { money: boolean; partners: boolean }): SeriesPoint {
  return {
    orders_placed: totals.placed,
    ...(may.money
      ? { revenue: totals.revenue.toFixed(2), average_value: totals.priced === 0 ? null : totals.revenue.div(totals.priced).toFixed(2) }
      : {}),
    on_time_rate: totals.due === 0 ? null : totals.onTime / totals.due,
    defect_rate: totals.inspected === 0 ? null : totals.withDefect / totals.inspected,
    ...(may.money && may.partners ? { partner_cost: totals.partnerCost.toFixed(2) } : {}),
  };
}
