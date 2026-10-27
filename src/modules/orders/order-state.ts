import { groupReady } from '../workflow/progress';
import type { LINE_STATES, ORDER_STATES } from './order-response';

// An order's and its lines' states, derived from pieces and shipment facts, never stored (Orders spec, goal 5).

export type LineState = (typeof LINE_STATES)[number];
export type OrderState = (typeof ORDER_STATES)[number];

/** Cancelled once cancelled; ready once every live piece is finished; in production until then. */
export function lineState(pieces: { status: string }[], cancelledAt: Date | null): LineState {
  if (cancelledAt) return 'cancelled';
  return groupReady(pieces) ? 'ready' : 'in_production';
}

/** Delivered, then shipped; else from the lines: every one cancelled, or every one ready or cancelled with one ready. */
export function orderState(lines: LineState[], shippedAt: Date | null, deliveredAt: Date | null): OrderState {
  if (deliveredAt) return 'delivered';
  if (shippedAt) return 'shipped';
  if (lines.every((line) => line === 'cancelled')) return 'cancelled';
  if (lines.every((line) => line !== 'in_production')) return 'ready';
  return 'in_production';
}
