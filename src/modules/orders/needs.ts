import type { Prisma } from '../../generated/prisma/client';
import type { PaymentState } from '../payments/payment-state';
import { workingDaysAfter } from './dates';
import type { BusinessCalendar } from './dates';
import type { OrderState } from './order-state';

// Why an order needs staff today (Orders list spec, goal 11): one rule, as a per-order function and as a
// query on the stored states, which an e2e test holds equal. Pure, so Reporting and the AI use it too.

export const NEEDS_REASONS = ['late', 'to_ship', 'to_collect', 'due_soon'] as const;
export type NeedsReason = (typeof NEEDS_REASONS)[number];

/** Working days on from today that an unfinished order is due soon; the attention rule's window too. */
export const DUE_SOON_WORKING_DAYS = 2;

/** The dates the rule compares with, as `YYYY-MM-DD` in the workspace. */
export interface NeedsDay {
  today: string;
  dueSoonUntil: string;
}

/** Not shipped yet: late once past its promised date. */
const UNSHIPPED: OrderState[] = ['awaiting_payment', 'in_production', 'ready'];
/** Not made yet: due soon near its promised date. */
const UNMADE: OrderState[] = ['awaiting_payment', 'in_production'];

export function needsDay(today: string, calendar: BusinessCalendar): NeedsDay {
  return { today, dueSoonUntil: workingDaysAfter(today, DUE_SOON_WORKING_DAYS, calendar) };
}

/** Past its promised date and not shipped. */
export function isLate(state: OrderState, promisedOn: string, today: string): boolean {
  return promisedOn < today && UNSHIPPED.includes(state);
}

/** Every reason the order matches, in `NEEDS_REASONS` order. */
export function orderNeeds(order: { state: OrderState; paymentState: PaymentState; promisedOn: string }, day: NeedsDay): NeedsReason[] {
  const matches: Record<NeedsReason, boolean> = {
    late: isLate(order.state, order.promisedOn, day.today),
    to_ship: order.state === 'ready',
    to_collect: order.paymentState === 'overdue' || order.state === 'awaiting_payment',
    due_soon: UNMADE.includes(order.state) && order.promisedOn >= day.today && order.promisedOn <= day.dueSoonUntil,
  };
  return NEEDS_REASONS.filter((reason) => matches[reason]);
}

const asDay = (day: string) => new Date(`${day}T00:00:00Z`);

/** Orders matching any of `reasons`, on the stored states; an order not computed yet matches none. */
export function needsWhere(reasons: readonly NeedsReason[], day: NeedsDay): Prisma.OrderWhereInput {
  const rules: Record<NeedsReason, Prisma.OrderWhereInput> = {
    late: { promisedOn: { lt: asDay(day.today) }, state: { in: UNSHIPPED } },
    to_ship: { state: 'ready' },
    to_collect: { OR: [{ paymentState: 'overdue' }, { state: 'awaiting_payment' }] },
    due_soon: { promisedOn: { gte: asDay(day.today), lte: asDay(day.dueSoonUntil) }, state: { in: UNMADE } },
  };
  return { AND: [{ state: { not: null } }, { paymentState: { not: null } }, { OR: reasons.map((reason) => rules[reason]) }] };
}
