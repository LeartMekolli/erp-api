import { z } from 'zod';

// What clients receive for partners; checked against real responses in the e2e tests.

export const PARTNER_STATUSES = ['setting_up', 'approved', 'suspended'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export const partnerResponseSchema = z.strictObject({
  id: z.uuid(),
  /** The company's own name, for staff. */
  name: z.string(),
  /** The name customers see when they may pick a workshop. */
  display_name: z.string(),
  /** Only approved partners are offered jobs. */
  status: z.enum(PARTNER_STATUSES),
  /** Takes any job a customer sends it directly, without an offer to accept. */
  accepts_direct_orders: z.boolean(),
  /** The signed agreement on file; approval needs it. */
  agreement: z.strictObject({ file_version_id: z.uuid(), signed_on: z.iso.date() }).nullable(),
  member_count: z.number().int(),
  created_at: z.iso.datetime(),
});
export type PartnerResponse = z.infer<typeof partnerResponseSchema>;
