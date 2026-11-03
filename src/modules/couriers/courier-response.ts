import { z } from 'zod';
import { addressSchema } from '../orders/order-response';

const secretSchema = z.string().trim().min(8).max(500);

/** The workspace's courier service account (Orders 3 spec, goal 21): its key, its webhook secret, and where labels ship from. */
export const setCourierAccountSchema = z.strictObject({
  api_key: secretSchema,
  webhook_secret: secretSchema,
  /** Where labels ship from and returns go to. */
  from_address: addressSchema,
});
export type SetCourierAccount = z.infer<typeof setCourierAccountSchema>;

/** Never the key or the secret. */
export const courierAccountResponseSchema = z.strictObject({
  configured: z.boolean(),
  /** `test` for an EasyPost test key; null until set. */
  mode: z.enum(['test', 'live']).nullable(),
  from_address: addressSchema.nullable(),
  /** The address to register at the courier service for tracking updates. */
  webhook_url: z.string(),
});
export type CourierAccountResponse = z.infer<typeof courierAccountResponseSchema>;

export const shippingRatesSchema = z.strictObject({
  customer_id: z.uuid(),
  /** Where the order would go; the customer's saved shipping address when left out. */
  address: addressSchema.optional(),
});
export type ShippingRatesBody = z.infer<typeof shippingRatesSchema>;
export const portalShippingRatesSchema = shippingRatesSchema.omit({ customer_id: true });
export type PortalShippingRatesBody = z.infer<typeof portalShippingRatesSchema>;

/** Each active shipping method's price for one order's address: a live rate fetched now, or the fixed price. */
export const shippingRatesResponseSchema = z.strictObject({
  data: z.array(
    z.strictObject({
      key: z.string(),
      name: z.string(),
      /** In the workspace's currency; null when the method can't be used for this address. */
      price: z.string().nullable(),
      available: z.boolean(),
      /** Why the method can't be used: no courier account, no rate for its service, another currency. */
      reason: z.string().nullable(),
    }),
  ),
});
export type ShippingRatesResponse = z.infer<typeof shippingRatesResponseSchema>;
