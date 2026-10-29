import { z } from 'zod';
import { weekMetricsSchema } from './week-metrics';

const { orders, customers } = weekMetricsSchema.shape;

/** A week as the reader sees it: money and partner figures are absent without their permission. */
export const readerWeekSchema = weekMetricsSchema.extend({
  orders: orders.extend({ revenue: orders.shape.revenue.optional(), average_value: orders.shape.average_value.optional() }),
  customers: customers.extend({
    top: z.array(customers.shape.top.element.extend({ revenue: customers.shape.top.element.shape.revenue.optional() })).max(5),
    slow_payers: customers.shape.slow_payers.optional(),
  }),
  partners: weekMetricsSchema.shape.partners.optional(),
});

export const dashboardResponseSchema = z.strictObject({
  week: z.strictObject({
    start: z.iso.date(),
    previous_start: z.iso.date(),
    // When the numbers were last computed; null before the first refresh.
    computed_at: z.string().nullable(),
  }),
  current: readerWeekSchema,
  previous: readerWeekSchema,
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
