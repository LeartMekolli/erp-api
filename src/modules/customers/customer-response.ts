import { z } from 'zod';
import { CUSTOMER_ROLES } from './customer-roles';

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

/** An invitation to act for a customer; the token goes only to the invitee's inbox. */
export const customerInvitationResponseSchema = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  role: z.enum(CUSTOMER_ROLES),
  expires_at: z.string(),
});
export type CustomerInvitationResponse = z.infer<typeof customerInvitationResponseSchema>;

/** A person who acts for a customer, with their role there. */
export const customerMemberResponseSchema = z.strictObject({
  user_id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: z.enum(CUSTOMER_ROLES),
  /** The person's own status, the same in every customer they act for; disabled people cannot log in. */
  status: z.enum(['active', 'disabled']),
});
export type CustomerMemberResponse = z.infer<typeof customerMemberResponseSchema>;

/** The workspace's customer site: customer emails link there and it may call the API. */
export const customerSiteResponseSchema = z.strictObject({ origin: z.string().nullable() });
export type CustomerSiteResponse = z.infer<typeof customerSiteResponseSchema>;
