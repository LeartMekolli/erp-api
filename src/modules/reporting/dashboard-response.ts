import { z } from 'zod';
import { ATTENTION_KINDS, MAX_ITEMS } from './attention.service';
import { weekMetricsSchema } from './week-metrics';

/** What needs attention now: every kind the reader may see, each with its total and its first items. */
export const attentionSchema = z.array(
  z.strictObject({
    kind: z.enum(ATTENTION_KINDS),
    total: z.number().int().min(0),
    items: z
      .array(
        z.strictObject({
          ref: z.strictObject({ type: z.enum(['order', 'customer', 'partner', 'invoice', 'job', 'article', 'step']), id: z.uuid() }),
          label: z.string(),
          since: z.string().nullable(),
        }),
      )
      .max(MAX_ITEMS),
  }),
);

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
  attention: attentionSchema,
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
