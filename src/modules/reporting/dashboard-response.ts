import { z } from 'zod';
import { SUGGESTION_KINDS } from '../ai/suggestions';
import { RECORD_TYPES } from '../ai/tools/tool';
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

const labelledRefSchema = z.strictObject({ type: z.enum(RECORD_TYPES), id: z.uuid(), label: z.string() });

/**
 * The managers' AI briefing: only for staff with `report.read`, `payment.read` and `partner.read`
 * (absent for anyone else). Dismissed suggestions, and ones whose target is gone, are left out.
 */
export const aiSectionSchema = z.discriminatedUnion('enabled', [
  z.strictObject({
    enabled: z.literal(true),
    briefing: z
      .strictObject({
        summary: z.string(),
        created_at: z.string(),
        suggestions: z.array(
          z.strictObject({ id: z.uuid(), kind: z.enum(SUGGESTION_KINDS), targets: z.array(labelledRefSchema), reason: z.string() }),
        ),
      })
      .nullable(),
    // A briefing is being written.
    pending: z.boolean(),
    // Dismissed in the last 14 days, newest first; each can be undone.
    dismissed: z.array(
      z.strictObject({
        id: z.uuid(),
        kind: z.enum(SUGGESTION_KINDS),
        targets: z.array(labelledRefSchema),
        dismissed_by: z.strictObject({ id: z.uuid(), name: z.string() }),
        dismissed_at: z.string(),
        // Not suggested again before then.
        until: z.string(),
      }),
    ),
  }),
  z.strictObject({ enabled: z.literal(false), reason: z.enum(['not_set_up', 'limit_used']) }),
]);
export type AiSection = z.infer<typeof aiSectionSchema>;

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
  ai: aiSectionSchema.optional(),
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
