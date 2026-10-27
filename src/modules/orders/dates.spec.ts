import { promisedDate, workingDaysBefore } from './dates';
import type { BusinessCalendar } from './dates';

describe('working days before a date', () => {
  const calendar: BusinessCalendar = { workingDays: [1, 2, 3, 4, 5], endHour: 17, closedDates: ['2026-12-25'] };

  it('counts open days back, skipping weekends and closed dates', () => {
    expect(workingDaysBefore('2026-12-29', 2, calendar)).toBe('2026-12-24');
    expect(workingDaysBefore('2026-12-28', 1, calendar)).toBe('2026-12-24');
    expect(workingDaysBefore('2026-12-22', 1, calendar)).toBe('2026-12-21');
  });

  it('counts from a day that is itself closed', () => {
    expect(workingDaysBefore('2026-12-27', 1, calendar)).toBe('2026-12-24');
  });

  it('makes zero days the date itself, even on a day off', () => {
    expect(workingDaysBefore('2026-12-29', 0, calendar)).toBe('2026-12-29');
    expect(workingDaysBefore('2026-12-27', 0, calendar)).toBe('2026-12-27');
  });
});

describe('promised dates', () => {
  const calendar: BusinessCalendar = { workingDays: [1, 2, 3, 4, 5], endHour: 17, closedDates: ['2026-12-25'] };
  const zone = 'Europe/Belgrade';

  it('counts working days from a working day placed before closing', () => {
    expect(promisedDate(new Date('2026-12-21T09:00:00Z'), 3, calendar, zone)).toBe('2026-12-24');
  });

  it('skips closed dates and weekends', () => {
    expect(promisedDate(new Date('2026-12-23T09:00:00Z'), 2, calendar, zone)).toBe('2026-12-28');
  });

  it('starts from the next working day after closing time', () => {
    // 18:00 local, after the 17:00 close.
    expect(promisedDate(new Date('2026-12-21T17:00:00Z'), 1, calendar, zone)).toBe('2026-12-23');
  });

  it('uses the workspace timezone, not UTC', () => {
    // 23:30 UTC on Monday is 00:30 on Tuesday in Belgrade.
    expect(promisedDate(new Date('2026-12-21T23:30:00Z'), 0, calendar, zone)).toBe('2026-12-22');
  });

  it('makes zero days the first working day', () => {
    // Saturday: the first working day is Monday.
    expect(promisedDate(new Date('2026-12-19T09:00:00Z'), 0, calendar, zone)).toBe('2026-12-21');
  });

  it('treats a calendar without closed dates as having none', () => {
    expect(promisedDate(new Date('2026-12-24T09:00:00Z'), 1, { workingDays: [1, 2, 3, 4, 5], endHour: 17, closedDates: [] }, zone)).toBe(
      '2026-12-25',
    );
  });
});