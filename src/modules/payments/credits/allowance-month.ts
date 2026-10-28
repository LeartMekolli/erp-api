import { localDate, startOfLocalDay } from '../../orders/dates';

/**
 * How a customer's allowance months are counted (Payments 2 spec, goal 9): on a paid plan from the
 * moment its subscription became active, on the free plan by the workspace's calendar.
 */
export type AllowanceClock = { kind: 'paid'; anchor: Date } | { kind: 'free'; timezone: string };

/**
 * `from` plus `months`, on the same day and time, or the month's last day when it is shorter: how the
 * payment provider counts a billing period. Always counted from `from`, so a 31st comes back.
 */
export function addMonths(from: Date, months: number): Date {
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  target.setUTCHours(from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds());
  return target;
}

/**
 * The allowance month containing `at`, from its first moment to the first moment of the next. Paid
 * months are the anchor plus whole months; free months are calendar months in the time zone.
 */
export function allowanceMonth(at: Date, clock: AllowanceClock): { start: Date; end: Date } {
  if (clock.kind === 'free') {
    const [year, month] = localDate(at, clock.timezone).split('-').map(Number);
    const first = (y: number, m: number) => {
      const date = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
      return startOfLocalDay(date, clock.timezone);
    };
    return { start: first(year, month), end: first(year, month + 1) };
  }

  const { anchor } = clock;
  let months = (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (at.getUTCMonth() - anchor.getUTCMonth());
  // The month difference is off by one when `at` is before the anchor's day and time in its month.
  if (addMonths(anchor, months) > at) months -= 1;
  else if (addMonths(anchor, months + 1) <= at) months += 1;
  return { start: addMonths(anchor, months), end: addMonths(anchor, months + 1) };
}
