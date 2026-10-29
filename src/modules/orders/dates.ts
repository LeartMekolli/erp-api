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

/** The calendar date of `at` in `timeZone`. */
export function localDate(at: Date, timeZone: string): string {
  return localParts(at, timeZone).date;
}

/** The calendar date, ISO weekday and hour of `at` in `timeZone`. */
function localParts(at: Date, timeZone: string): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** The instant the calendar date `date` begins in `timeZone`. */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const midnightUtc = new Date(`${date}T00:00:00Z`).getTime();
  // The zone's offset at a first guess, then once more at the result, for a day a clock change starts.
  const guess = midnightUtc - zoneOffsetMs(new Date(midnightUtc), timeZone);
  return new Date(midnightUtc - zoneOffsetMs(new Date(guess), timeZone));
}

/** How far `timeZone`'s wall clock is ahead of UTC at `at`. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The ISO weekday of a calendar date, which has no timezone of its own. */
function weekday(date: string): number {
  return WEEKDAY[new Intl.DateTimeFormat('en', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${date}T00:00:00Z`))];
}

function nextDay(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10);
}

function previousDay(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - DAY_MS).toISOString().slice(0, 10);
}

/** Open: a working weekday that isn't a closed date. */
function isOpen(date: string, calendar: BusinessCalendar): boolean {
  return calendar.workingDays.includes(weekday(date)) && !calendar.closedDates.includes(date);
}

/**
 * The day `days` open days before `date` (Orders spec, B3), for a due date counted back from a promised
 * one. Zero days is `date` itself, even when it is a day off.
 */
export function workingDaysBefore(date: string, days: number, calendar: BusinessCalendar): string {
  let day = date;
  for (let left = days; left > 0; left -= 1) {
    do day = previousDay(day);
    while (!isOpen(day, calendar));
  }
  return day;
}

/** The day `days` open days after `date`. Zero days is `date` itself, even when it is a day off. */
export function workingDaysAfter(date: string, days: number, calendar: BusinessCalendar): string {
  let day = date;
  for (let left = days; left > 0; left -= 1) {
    do day = nextDay(day);
    while (!isOpen(day, calendar));
  }
  return day;
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