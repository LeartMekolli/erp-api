import { allowanceMonth } from './allowance-month';

const at = (iso: string) => new Date(iso);

describe('allowanceMonth', () => {
  describe('on a paid plan, counted from the anchor', () => {
    const clock = { kind: 'paid' as const, anchor: at('2026-01-31T10:00:00Z') };

    it('starts with the anchor itself', () => {
      expect(allowanceMonth(at('2026-01-31T10:00:00Z'), clock)).toEqual({
        start: at('2026-01-31T10:00:00Z'),
        end: at('2026-02-28T10:00:00Z'),
      });
    });

    it('falls on the last day of a month too short for the anchor day', () => {
      expect(allowanceMonth(at('2026-02-15T00:00:00Z'), clock)).toEqual({
        start: at('2026-01-31T10:00:00Z'),
        end: at('2026-02-28T10:00:00Z'),
      });
    });

    it('goes back to the anchor day once the month is long enough', () => {
      expect(allowanceMonth(at('2026-03-01T00:00:00Z'), clock)).toEqual({
        start: at('2026-02-28T10:00:00Z'),
        end: at('2026-03-31T10:00:00Z'),
      });
      expect(allowanceMonth(at('2026-04-15T00:00:00Z'), clock)).toEqual({
        start: at('2026-03-31T10:00:00Z'),
        end: at('2026-04-30T10:00:00Z'),
      });
    });

    it('puts the moment a month ends in the next one', () => {
      expect(allowanceMonth(at('2026-02-28T10:00:00Z'), clock).start).toEqual(at('2026-02-28T10:00:00Z'));
    });

    it('counts across a year', () => {
      expect(allowanceMonth(at('2027-01-31T09:59:59Z'), clock)).toEqual({
        start: at('2026-12-31T10:00:00Z'),
        end: at('2027-01-31T10:00:00Z'),
      });
    });
  });

  describe('on the free plan, by calendar months in the workspace', () => {
    it('follows the time zone, across a change of the clocks', () => {
      // 23:30 UTC on 31 October is 00:30 on 1 November in Belgrade, a week after summer time ends.
      expect(allowanceMonth(at('2026-10-31T23:30:00Z'), { kind: 'free', timezone: 'Europe/Belgrade' })).toEqual({
        start: at('2026-10-31T23:00:00Z'),
        end: at('2026-11-30T23:00:00Z'),
      });
    });

    it('is the calendar month in UTC', () => {
      expect(allowanceMonth(at('2026-12-31T23:59:59Z'), { kind: 'free', timezone: 'UTC' })).toEqual({
        start: at('2026-12-01T00:00:00Z'),
        end: at('2027-01-01T00:00:00Z'),
      });
    });
  });
});
