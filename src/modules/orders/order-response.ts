import { z } from 'zod';

// What clients receive for orders and their setup; checked against real responses in the e2e tests.

const line = z.string().trim().min(1).max(200);

/** Where an order goes, as typed with the order and copied onto it (Orders spec, goal 9). */
export const addressSchema = z.strictObject({
  name: line,
  line1: line,
  line2: line.optional(),
  city: line,
  postal_code: z.string().trim().min(1).max(20),
  region: z.string().trim().min(1).max(100).optional(),
  /** ISO 3166-1 alpha-2, upper case. */
  country: z.string().regex(/^[A-Z]{2}$/, 'an ISO 3166-1 alpha-2 country code, such as DE'),
  phone: z.string().trim().min(1).max(40).optional(),
});
export type Address = z.infer<typeof addressSchema>;

export const shippingMethodResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  /** Per order, in the workspace's currency. */
  price: z.string(),
  /** Only active methods can be chosen for a new order. */
  active: z.boolean(),
});
export type ShippingMethodResponse = z.infer<typeof shippingMethodResponseSchema>;

export const taxRateResponseSchema = z.strictObject({
  /** Null for the workspace's default rate. */
  country: z.string().nullable(),
  /** Null for the whole country. */
  region: z.string().nullable(),
  percent: z.string(),
});
export type TaxRateResponse = z.infer<typeof taxRateResponseSchema>;

/** The workspace's tax rates: the default first, then by country and region. */
export const taxRatesResponseSchema = z.strictObject({ data: z.array(taxRateResponseSchema) });
export type TaxRatesResponse = z.infer<typeof taxRatesResponseSchema>;
