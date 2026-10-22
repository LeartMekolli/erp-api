import { z } from 'zod';

// What staff receive for customer organisations; checked against real responses in the e2e tests.

export const customerResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(['active', 'disabled']),
  /** The Pricing customer group whose markup or discount the customer's quotes get. */
  customer_group: z.strictObject({ id: z.uuid(), key: z.string(), name: z.string() }).nullable(),
  /** People who can act for the customer. */
  member_count: z.number().int(),
  created_at: z.string(),
});
export type CustomerResponse = z.infer<typeof customerResponseSchema>;
