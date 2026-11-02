import { z } from 'zod';

// A customer's priority as staff see it (Customers 2 spec, goal 16); never part of a portal response.

export const bandSchema = z.strictObject({ key: z.string(), name: z.string() });

const partSchema = z.number().int().min(0).max(100);

export const customerPriorityResponseSchema = z.strictObject({
  /** 0–100, from the last run; 0 for a customer not compared (no order in the last 365 days) or never computed. */
  score: z.number().int().min(0).max(100),
  /** Each part's percentile rank among the workspace's customers that ordered in the last 365 days. */
  parts: z.strictObject({ lifetime: partSchema, recent: partSchema, frequency: partSchema, payment: partSchema }),
  /** The band the score puts the customer in; a band since removed from the settings reads as the default. */
  computed_band: bandSchema,
  /** Staff's band for the customer, in force through `ends_on` (in the workspace's zone). */
  override: z.strictObject({ band: bandSchema, reason: z.string(), ends_on: z.iso.date() }).nullable(),
  /** The band in force: the override while it lasts, else the computed band. */
  band: bandSchema,
  computed_at: z.string().nullable(),
});
export type CustomerPriorityResponse = z.infer<typeof customerPriorityResponseSchema>;
