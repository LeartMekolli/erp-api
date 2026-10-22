import { z } from 'zod';
import { blocksSchema } from './blocks';

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

export const categoryChainResponseSchema = z.strictObject({
  category_id: z.uuid(),
  /** In chain order. */
  steps: z.array(stepTypeResponseSchema),
});
export type CategoryChainResponse = z.infer<typeof categoryChainResponseSchema>;

export const productChainResponseSchema = z.strictObject({
  product_id: z.uuid(),
  /** True when the product replaces its category's chain; `steps` is then the product's own. */
  own_chain: z.boolean(),
  steps: z.array(stepTypeResponseSchema),
});
export type ProductChainResponse = z.infer<typeof productChainResponseSchema>;

export const stepEffectsResponseSchema = z.strictObject({
  value_id: z.uuid(),
  /** Steps choosing the value adds. */
  add: z.array(stepTypeResponseSchema),
  /** Steps choosing the value removes. */
  remove: z.array(stepTypeResponseSchema),
});
export type StepEffectsResponse = z.infer<typeof stepEffectsResponseSchema>;

export const stepPriceResponseSchema = z.strictObject({
  id: z.uuid(),
  step_type_id: z.uuid(),
  /** The material this price is for; null for the step's default, used for any other material. */
  material_id: z.uuid().nullable(),
  /** A % on the step's whole cost per piece. */
  failure_percent: z.string(),
  blocks: blocksSchema,
});
export type StepPriceResponse = z.infer<typeof stepPriceResponseSchema>;
