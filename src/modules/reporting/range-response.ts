import { z } from 'zod';
import { readerWeekSchema } from './dashboard-response';
import { BUCKETS } from './range-buckets';
import { rangeMetricsSchema } from './range-metrics';
import { seriesEntrySchema } from './series';

// `GET /reports/range` (dashboard data spec, "Range response").

const { orders, partners } = rangeMetricsSchema.shape;

/** A range's numbers as the reader sees them (`forRangeReader`): money and partner figures absent without their permission. */
export const readerRangeSchema = rangeMetricsSchema.extend({
  orders: orders.extend({
    revenue: orders.shape.revenue.optional(),
    average_value: orders.shape.average_value.optional(),
    by_product: orders.shape.by_product.optional(),
    by_customer_group: orders.shape.by_customer_group.optional(),
  }),
  customers: readerWeekSchema.shape.customers,
  // `cost` needs `payment.read` as well.
  partners: partners.extend({ cost: partners.shape.cost.optional() }).optional(),
});

export const rangeResponseSchema = z.strictObject({
  range: z.strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    // The same number of days, ending the day before `from`.
    previous_from: z.iso.date(),
    previous_to: z.iso.date(),
    bucket: z.enum(BUCKETS),
  }),
  current: readerRangeSchema,
  previous: readerRangeSchema,
  // Every bucket of the range, oldest first, an empty one with zero counts, "0.00" money and null rates.
  series: z.array(seriesEntrySchema),
  // The workspace's `reports.targets` on-time rate; null while unset.
  on_time_target: z.number().min(0).max(1).nullable(),
  computed_at: z.iso.datetime(),
});
export type RangeResponse = z.infer<typeof rangeResponseSchema>;
