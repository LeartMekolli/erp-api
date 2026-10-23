import { z } from 'zod';
import { MEASURE_TYPES } from '../files/measurers';
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
  /** Where the step's cost shows in the customer summary; null for a step nobody prices, such as final QC. */
  summary_group: z.enum(SUMMARY_GROUPS).nullable(),
  /** False for a not-priced step: it can't be in a chain or have a price, and runs in every workflow it is part of. */
  priced: z.boolean(),
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

export const marginOverrideResponseSchema = z.strictObject({
  /** Set when the override is a category's; then `product_id` is null, and the other way round. */
  category_id: z.uuid().nullable(),
  product_id: z.uuid().nullable(),
  margin_percent: z.string(),
});
export type MarginOverrideResponse = z.infer<typeof marginOverrideResponseSchema>;

export const discountTierResponseSchema = z.strictObject({
  /** From this many pieces on; the highest tier reached applies. */
  min_quantity: z.number().int(),
  percent: z.string(),
});
export const discountTiersResponseSchema = z.strictObject({
  /** By quantity, lowest first. */
  data: z.array(discountTierResponseSchema),
});
export type DiscountTiersResponse = z.infer<typeof discountTiersResponseSchema>;

export const customerGroupResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  /** A markup when positive, a discount when negative. */
  percent: z.string(),
});
export type CustomerGroupResponse = z.infer<typeof customerGroupResponseSchema>;

export const deliverySpeedResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  surcharge_percent: z.string(),
  /** The speed a quote gets when it names none; at most one is the default. */
  is_default: z.boolean(),
});
export type DeliverySpeedResponse = z.infer<typeof deliverySpeedResponseSchema>;

export const minSizeSurchargeResponseSchema = z.strictObject({
  id: z.uuid(),
  /** Null when it applies to every category. */
  category_id: z.uuid().nullable(),
  measure: z.enum(MEASURE_TYPES),
  /** Applies when the scaled design's measure is below this, in `unit`. */
  below: z.string(),
  unit: z.string(),
  /** Added once per piece. */
  amount: z.string(),
});
export type MinSizeSurchargeResponse = z.infer<typeof minSizeSurchargeResponseSchema>;
