import { z } from 'zod';

// What clients receive for a material: the docs show it and the e2e tests check
// real responses against it. Decimals are strings, never floats.

export const currentPriceSchema = z.strictObject({
  unit_price: z.string(),
  currency: z.string(),
  per_unit: z.string(),
  source: z.enum(['override', 'manual', 'feed', 'fallback']),
  as_of: z.string().nullable(),
  stale: z.boolean(),
});

export const materialResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  priced_unit: z.string(),
  density_g_cm3: z.string().nullable(),
  price_source: z.enum(['feed', 'manual']),
  feed_metal: z.string().nullable(),
  addon_percent: z.string(),
  addon_amount: z.string(),
  manual_price: z.string().nullable(),
  fallback_price: z.string().nullable(),
  currency: z.string(),
  override: z
    .strictObject({ price: z.string(), reason: z.string().nullable(), at: z.string(), by_user_id: z.string().nullable() })
    .nullable(),
  /** Null when the material has no usable price; `price_missing` says why. */
  current_price: currentPriceSchema.nullable(),
  price_missing: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type MaterialResponse = z.infer<typeof materialResponseSchema>;
