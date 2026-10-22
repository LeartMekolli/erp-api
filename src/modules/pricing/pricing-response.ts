import { z } from 'zod';

// What clients receive for pricing configuration; checked against real
// responses in the e2e tests. Decimals are strings, never floats.

export const SUMMARY_GROUPS = ['material', 'making', 'finishing'] as const;
export type SummaryGroup = (typeof SUMMARY_GROUPS)[number];

export const stepTypeResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  /** Orders the steps of a chain, lowest first. */
  position: z.number().int(),
  /** Where the step's cost shows in the customer summary. */
  summary_group: z.enum(SUMMARY_GROUPS),
});
export type StepTypeResponse = z.infer<typeof stepTypeResponseSchema>;

export const pricingProfileResponseSchema = z.strictObject({
  /** Profit on cost, unless a category or product sets its own. */
  margin_percent: z.string(),
  overhead_per_piece: z.string(),
  /** How long a quote holds its price. */
  quote_valid_days: z.number().int(),
});
export type PricingProfileResponse = z.infer<typeof pricingProfileResponseSchema>;
