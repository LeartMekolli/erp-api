import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { keySchema } from '../pricing/decimals';
import type { BusinessCalendar } from './dates';
import { addressSchema } from './order-response';

/** What an order is placed with, from staff or the customer app (Orders spec, goal 1). */
export const placeOrderSchema = z.strictObject({
  /** One per configured product, each the quote the price was shown by; a quote is ordered once. */
  lines: z
    .array(z.strictObject({ quote_id: z.uuid() }))
    .min(1)
    .max(50)
    .refine((lines) => new Set(lines.map((line) => line.quote_id)).size === lines.length, 'a quote can be in an order once'),
  address: addressSchema,
  /** The key of an active shipping method. */
  shipping_method: keySchema,
  note: z.string().trim().min(1).max(2000).optional(),
  /** An outside channel's own id for the order; each is placed once per channel. */
  channel_order_id: z.string().trim().min(1).max(200).optional(),
});
export type PlaceOrder = z.infer<typeof placeOrderSchema>;

/** Staff place an order for a customer of the workspace. */
export const staffPlaceOrderSchema = placeOrderSchema.extend({ customer_id: z.uuid() });
export type StaffPlaceOrder = z.infer<typeof staffPlaceOrderSchema>;

/** The calendar a workspace that never set `business.calendar` works by. */
export const DEFAULT_CALENDAR: BusinessCalendar = { workingDays: [1, 2, 3, 4, 5], endHour: 17, closedDates: [] };

/** The one delivery speed every line was priced at (Orders spec, goal 7); mixed speeds are refused. */
export function commonSpeed(speeds: (string | null)[]): { ok: true; speed: string | null } | { ok: false } {
  const distinct = new Set(speeds);
  return distinct.size === 1 ? { ok: true, speed: speeds[0] } : { ok: false };
}

/** The order's totals, frozen when it is placed (goal 11): the lines, then shipping and tax on top. */
export function orderTotals(
  lineTotals: Prisma.Decimal[],
  shipping: Prisma.Decimal,
  tax: Prisma.Decimal,
): { linesTotal: Prisma.Decimal; total: Prisma.Decimal } {
  const linesTotal = lineTotals.reduce((sum, total) => sum.plus(total), new Prisma.Decimal(0));
  return { linesTotal, total: linesTotal.plus(shipping).plus(tax) };
}

/**
 * The workspace's next order number, from 1001. The counter row is created by the first order and
 * raised under its row lock after that, so two orders placed at once never share a number.
 */
export async function nextOrderNumber(tx: Prisma.TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO order_counter (last_number) VALUES (1001)
    ON CONFLICT (tenant_id) DO UPDATE SET last_number = order_counter.last_number + 1
    RETURNING last_number`;
  return rows[0].last_number;
}
