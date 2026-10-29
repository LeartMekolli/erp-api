import { medianHours, onTimeRate, orderingLess, weekOf } from './week-metrics';

/** `days` calendar days before `date`. */
function daysBefore(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

describe('weekOf', () => {
  it("is the ISO week, from Monday, in the workspace's time zone", () => {
    // Sunday 23:30 UTC is already Monday 00:30 in Belgrade.
    const at = new Date('2026-11-01T23:30:00Z');

    expect(weekOf(at, 'Europe/Belgrade')).toEqual({ start: '2026-11-02', previousStart: '2026-10-26' });
    expect(weekOf(at, 'UTC')).toEqual({ start: '2026-10-26', previousStart: '2026-10-19' });
  });

  it('keeps a Monday in its own week and crosses the year', () => {
    expect(weekOf(new Date('2026-10-26T00:00:00Z'), 'UTC')).toEqual({ start: '2026-10-26', previousStart: '2026-10-19' });
    expect(weekOf(new Date('2027-01-01T12:00:00Z'), 'UTC')).toEqual({ start: '2026-12-28', previousStart: '2026-12-21' });
  });
});

describe('onTimeRate', () => {
  const today = '2026-10-29';

  it('is the share of lines due that were ready by their promised date', () => {
    expect(
      onTimeRate(
        [
          { promisedOn: '2026-10-27', readyOn: '2026-10-26' },
          { promisedOn: '2026-10-27', readyOn: '2026-10-27' },
          { promisedOn: '2026-10-28', readyOn: '2026-10-28' },
          { promisedOn: '2026-10-28', readyOn: '2026-10-29' },
        ],
        today,
      ),
    ).toBe(0.75);
  });

  it('counts a line not ready past its promised date as late, and one not yet due not at all', () => {
    expect(
      onTimeRate(
        [
          { promisedOn: '2026-10-27', readyOn: null },
          { promisedOn: '2026-10-28', readyOn: '2026-10-28' },
          { promisedOn: '2026-10-30', readyOn: null },
        ],
        today,
      ),
    ).toBe(0.5);
  });

  it('is null when no line is due', () => {
    expect(onTimeRate([], today)).toBeNull();
    expect(onTimeRate([{ promisedOn: '2026-10-30', readyOn: null }], today)).toBeNull();
  });
});

describe('medianHours', () => {
  it('is the middle value, or the mean of the two middle ones', () => {
    expect(medianHours([9, 1, 5])).toBe(5);
    expect(medianHours([1, 2])).toBe(1.5);
  });

  it('is null for no durations', () => {
    expect(medianHours([])).toBeNull();
  });
});

describe('orderingLess', () => {
  const today = '2026-10-29';
  /** Orders every 10 days, the last `lastDaysAgo` days before today. */
  const every10 = (id: string, lastDaysAgo: number, count = 4) => ({
    id,
    name: id,
    orderDates: Array.from({ length: count }, (_, index) => daysBefore(today, lastDaysAgo + index * 10)),
  });

  it('lists a customer with at least three orders and none for more than twice its usual interval', () => {
    expect(orderingLess([every10('late', 25)], today)).toEqual([{ id: 'late', name: 'late', last_order_on: daysBefore(today, 25) }]);
  });

  it('leaves out a customer still within twice its interval, or with fewer than three orders', () => {
    expect(orderingLess([every10('recent', 15), every10('new', 40, 2)], today)).toEqual([]);
  });

  it('lists the longest silent first, at most 20', () => {
    const customers = Array.from({ length: 25 }, (_, index) => every10(`c${String(index).padStart(2, '0')}`, 25 + index));

    const listed = orderingLess(customers, today);

    expect(listed).toHaveLength(20);
    expect(listed[0].id).toBe('c24');
  });
});
