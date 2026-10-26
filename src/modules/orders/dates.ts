/** What a promised date needs of the workspace's `business.calendar` setting. */
export interface BusinessCalendar {
  /** ISO weekdays: 1 is Monday, 7 is Sunday. */
  workingDays: number[];
  /** Orders placed at or after this hour count from the next working day. */
  endHour: number;
  closedDates: string[];
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const DAY_MS = 86_400_000;

/** The calendar date, ISO weekday and hour of `at` in `timeZone`. */
function localParts(at: Date, timeZone: string): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** The ISO weekday of a calendar date, which has no timezone of its own. */
function weekday(date: string): number {
  return WEEKDAY[new Intl.DateTimeFormat('en', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${date}T00:00:00Z`))];
}

function nextDay(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10);
}

/**
 * The day an order placed at `placedAt` is promised for (Orders spec, goal 8 and B1): counted from
 * the placing day in the workspace's timezone if it is open and before closing time, else from the
 * next open day, plus `workingDays` open days. Open: a working weekday that isn't a closed date.
 */
export function promisedDate(placedAt: Date, workingDays: number, calendar: BusinessCalendar, timeZone: string): string {
  const closed = new Set(calendar.closedDates);
  const open = (date: string) => calendar.workingDays.includes(weekday(date)) && !closed.has(date);

  const local = localParts(placedAt, timeZone);
  let day = local.date;
  if (!open(day) || local.hour >= calendar.endHour) {
    do day = nextDay(day);
    while (!open(day));
  }
  for (let left = workingDays; left > 0; left -= 1) {
    do day = nextDay(day);
    while (!open(day));
  }
  return day;
}