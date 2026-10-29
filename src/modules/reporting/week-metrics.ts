import { z } from 'zod';
import { localDate } from '../orders/dates';

// The dashboard's numbers for one week (AI 1 spec, goal 4): pure functions over rows the service loads,
// and the shape a `report_week` row holds.

const DAY_MS = 86_400_000;
const money = z.string().regex(/^-?\d+\.\d{2}$/);
const rate = z.number().min(0).max(1);
const count = z.number().int().min(0);

export const weekMetricsSchema = z.strictObject({
  // The workspace's currency; every money figure is in it.
  currency: z.string().length(3),
  orders: z.strictObject({
    placed: count,
    revenue: money,
    average_value: money.nullable(),
  }),
  production: z.strictObject({
    on_time_rate: rate.nullable(),
    step_hours: z.array(z.strictObject({ step_type_id: z.uuid(), name: z.string(), median_hours: z.number().min(0) })),
    defect_rate: rate.nullable(),
  }),
  customers: z.strictObject({
    new: count,
    top: z.array(z.strictObject({ id: z.uuid(), name: z.string(), revenue: money })).max(5),
    ordering_less: z.array(z.strictObject({ id: z.uuid(), name: z.string(), last_order_on: z.iso.date() })).max(20),
    slow_payers: z.array(z.strictObject({ id: z.uuid(), name: z.string(), overdue: money })).max(20),
  }),
  partners: z.strictObject({
    load: z.array(z.strictObject({ id: z.uuid(), name: z.string(), percent: count })),
    on_time: z.array(z.strictObject({ id: z.uuid(), name: z.string(), rate })),
  }),
});
export type WeekMetrics = z.infer<typeof weekMetricsSchema>;

/** A week with nothing in it, before the first refresh. */
export function emptyWeek(currency: string): WeekMetrics {
  return {
    currency,
    orders: { placed: 0, revenue: '0.00', average_value: null },
    production: { on_time_rate: null, step_hours: [], defect_rate: null },
    customers: { new: 0, top: [], ordering_less: [], slow_payers: [] },
    partners: { load: [], on_time: [] },
  };
}

/** `days` calendar days after `date`. */
export function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday starting the ISO week of `at` in `timeZone`, and the Monday before it. */
export function weekOf(at: Date, timeZone: string): { start: string; previousStart: string } {
  const today = localDate(at, timeZone);
  // 0 is Sunday; ISO weeks start on Monday.
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const start = addDays(today, -((weekday + 6) % 7));
  return { start, previousStart: addDays(start, -7) };
}

/**
 * The share of lines ready by their promised date, of the lines due: a line counts once its promised
 * date is before `today` or it is ready. Null when none is due.
 */
export function onTimeRate(lines: { promisedOn: string; readyOn: string | null }[], today: string): number | null {
  const due = lines.filter((line) => line.readyOn !== null || line.promisedOn < today);
  if (due.length === 0) return null;
  return due.filter((line) => line.readyOn !== null && line.readyOn <= line.promisedOn).length / due.length;
}

export function medianHours(durations: number[]): number | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Customers ordering less than usual: at least three orders, and none for more than twice their median
 * interval between orders. The longest silent first, at most 20.
 */
export function orderingLess(
  customers: { id: string; name: string; orderDates: string[] }[],
  today: string,
): { id: string; name: string; last_order_on: string }[] {
  const days = (date: string) => new Date(`${date}T00:00:00Z`).getTime() / DAY_MS;
  const listed: { id: string; name: string; last_order_on: string; silent: number }[] = [];
  for (const customer of customers) {
    if (customer.orderDates.length < 3) continue;
    const dates = [...customer.orderDates].sort();
    const usual = medianHours(dates.slice(1).map((date, index) => days(date) - days(dates[index])))!;
    const last = dates[dates.length - 1];
    const silent = days(today) - days(last);
    if (silent > 2 * usual) listed.push({ id: customer.id, name: customer.name, last_order_on: last, silent });
  }
  return listed
    .sort((a, b) => b.silent - a.silent)
    .slice(0, 20)
    .map(({ silent: _silent, ...customer }) => customer);
}

/**
 * The week as a reader may see it (goal 5): without `payment.read` no money figure, without
 * `partner.read` no partner figure. Left out, never zeroed.
 */
export function forReader(week: WeekMetrics, may: { money: boolean; partners: boolean }) {
  const { orders, customers, partners, ...rest } = week;
  return {
    ...rest,
    orders: may.money ? orders : { placed: orders.placed },
    customers: may.money
      ? customers
      : {
          new: customers.new,
          top: customers.top.map(({ revenue: _revenue, ...customer }) => customer),
          ordering_less: customers.ordering_less,
        },
    ...(may.partners ? { partners } : {}),
  };
}
