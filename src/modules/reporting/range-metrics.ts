import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { forReader, weekMetricsSchema } from './week-metrics';

// The dashboard's numbers for any range of dates (Reporting 2 spec, goals 14–15): a week's shape plus
// revenue per product, which the dashboard doesn't have.

const money = z.string().regex(/^-?\d+\.\d{2}$/);

export const rangeMetricsSchema = weekMetricsSchema.extend({
  orders: weekMetricsSchema.shape.orders.extend({
    /** Every product with revenue in the range, most first. */
    by_product: z.array(z.strictObject({ product_id: z.uuid(), name: z.string(), quantity: z.number().int().min(0), revenue: money })),
  }),
});
export type RangeMetrics = z.infer<typeof rangeMetricsSchema>;

/**
 * Revenue per product: the totals of the lines given (the caller leaves out cancelled lines and orders),
 * only those in `currency` as the dashboard counts revenue; most first, then by name.
 */
export function revenueByProduct(
  lines: { productId: string; name: string; quantity: number; total: Prisma.Decimal; currency: string }[],
  currency: string,
): RangeMetrics['orders']['by_product'] {
  const by = new Map<string, { name: string; quantity: number; revenue: Prisma.Decimal }>();
  for (const line of lines.filter((one) => one.currency === currency)) {
    const entry = by.get(line.productId) ?? { name: line.name, quantity: 0, revenue: new Prisma.Decimal(0) };
    entry.quantity += line.quantity;
    entry.revenue = entry.revenue.add(line.total);
    by.set(line.productId, entry);
  }
  return [...by]
    .sort(([, a], [, b]) => b.revenue.cmp(a.revenue) || a.name.localeCompare(b.name))
    .map(([productId, entry]) => ({ product_id: productId, name: entry.name, quantity: entry.quantity, revenue: entry.revenue.toFixed(2) }));
}

/** Range metrics as a reader may see them: as `forReader`, with revenue per product only for money readers. */
export function forRangeReader(metrics: RangeMetrics, may: { money: boolean; partners: boolean }) {
  const { orders, ...rest } = forReader(metrics, may);
  return { ...rest, orders: may.money ? metrics.orders : { placed: orders.placed } };
}
