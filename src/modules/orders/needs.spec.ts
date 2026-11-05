import type { BusinessCalendar } from './dates';
import { needsDay, orderNeeds } from './needs';
import type { OrderState } from './order-state';
import type { PaymentState } from '../payments/payment-state';

describe('needs you', () => {
  const calendar: BusinessCalendar = { workingDays: [1, 2, 3, 4, 5], endHour: 17, closedDates: [] };
  // A Thursday: two working days on is the following Monday.
  const day = needsDay('2026-11-05', calendar);
  const needs = (state: OrderState, promisedOn: string, paymentState: PaymentState = 'not_billed') =>
    orderNeeds({ state, paymentState, promisedOn }, day);

  it('counts the due-soon window in working days', () => {
    expect(day).toEqual({ today: '2026-11-05', dueSoonUntil: '2026-11-09' });
  });

  it('is late past its promised date until it ships', () => {
    for (const state of ['awaiting_payment', 'in_production', 'ready'] as const) {
      expect([state, needs(state, '2026-11-04')]).toEqual([state, expect.arrayContaining(['late'])]);
    }
    for (const state of ['shipped', 'delivered', 'cancelled'] as const) {
      expect([state, needs(state, '2026-11-04')]).toEqual([state, []]);
    }
    expect(needs('in_production', '2026-11-05')).not.toContain('late');
  });

  it('is to ship once ready, whatever the date', () => {
    expect(needs('ready', '2026-12-31')).toEqual(['to_ship']);
    expect(needs('ready', '2026-11-04')).toEqual(['late', 'to_ship']);
  });

  it('is to collect when its invoice is overdue, in any state, or while it waits for payment', () => {
    for (const state of ['in_production', 'ready', 'shipped', 'delivered'] as const) {
      expect([state, needs(state, '2026-12-31', 'overdue')]).toEqual([state, expect.arrayContaining(['to_collect'])]);
    }
    expect(needs('awaiting_payment', '2026-12-31', 'awaiting_payment')).toEqual(['to_collect']);
    expect(needs('shipped', '2026-12-31', 'invoiced')).toEqual([]);
  });

  it('is due soon from today to two working days on, until it is ready', () => {
    for (const promisedOn of ['2026-11-05', '2026-11-09']) {
      expect(needs('in_production', promisedOn)).toEqual(['due_soon']);
      expect(needs('awaiting_payment', promisedOn, 'awaiting_payment')).toEqual(['to_collect', 'due_soon']);
    }
    expect(needs('in_production', '2026-11-10')).toEqual([]);
    expect(needs('ready', '2026-11-06')).toEqual(['to_ship']);
  });

  it('gives every reason it matches, in order', () => {
    expect(needs('awaiting_payment', '2026-11-04', 'awaiting_payment')).toEqual(['late', 'to_collect']);
    expect(needs('ready', '2026-11-04', 'overdue')).toEqual(['late', 'to_ship', 'to_collect']);
  });
});
