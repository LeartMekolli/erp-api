import { z } from 'zod';
import { linePicksSchema } from '../orders/line-picks';

// Kept apart from group-summary.ts, whose reads pull in the orders module: work-order-response.ts is loaded by
// order-response.ts, so importing those reads from here would load order-response.ts in a cycle.

const date = z.iso.date();

/**
 * Whose a group's pieces are and when they are due, for Production's lists (Production lists spec, goal 1).
 * `order`, `claim` and `customer` are left out, never nulled, for a caller without `order.read` or `customer.read`.
 */
export const groupSummarySchema = z.strictObject({
  id: z.uuid(),
  workflow: z.strictObject({ id: z.uuid(), name: z.string(), version: z.number().int() }),
  /** The ordered picks of the line or part (a remake: of the claimed line); `[]` and null for a quote. */
  product: z
    .strictObject({ id: z.uuid(), name: z.string(), options: linePicksSchema.shape.options, size: linePicksSchema.shape.size })
    .nullable(),
  /** `order_line_part`: a part of an assembly line; `claim_line`: a remake of claimed pieces. */
  source: z.enum(['order_line', 'order_line_part', 'claim_line', 'quote']),
  /** The order and line (a part: its assembly's line; a remake: the claimed one); null for a quote. Only with `order.read`. */
  order: z.strictObject({ id: z.uuid(), number: z.number().int(), line_id: z.uuid() }).nullable().optional(),
  /** Set for a remake only. Only with `order.read`. */
  claim: z.strictObject({ id: z.uuid(), number: z.number().int() }).nullable().optional(),
  /** Only with `customer.read`. */
  customer: z.strictObject({ id: z.uuid(), name: z.string() }).nullable().optional(),
  /** The customer's promise: the order's promised date, or a remake's own; null for a quote. */
  due_on: date.nullable(),
  /** `due_on` is before the workspace's today and a piece is still active. */
  late: z.boolean(),
  /** The customer's priority band in force now; null without a customer. */
  priority: z.strictObject({ key: z.string(), name: z.string() }).nullable(),
  /**
   * The partner holding the job (accepted). `due_on` is the job's own date, earlier than the promise by the
   * buffer; `late`: that date is before today and the partner still has active pieces at its steps.
   */
  partner: z.strictObject({ id: z.uuid(), name: z.string(), due_on: date.nullable(), late: z.boolean() }).nullable(),
});
export type GroupSummary = z.infer<typeof groupSummarySchema>;
