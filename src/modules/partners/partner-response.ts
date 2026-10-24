import { z } from 'zod';
import { stepPriceResponseSchema } from '../pricing/pricing-response';
import { PARTNER_ROLES } from './partner-roles';

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
  /** When the partner's owner said its setup is ready for approval; null until then. */
  submitted_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
});
export type PartnerResponse = z.infer<typeof partnerResponseSchema>;

export const CAPACITY_PERIODS = ['day', 'week'] as const;

/** What a partner can do, how much, when it is closed and which option values it offers. */
export const partnerSetupResponseSchema = z.strictObject({
  partner_id: z.uuid(),
  /** Jobs offered or accepted at once; null for no limit. */
  max_open_jobs: z.number().int().nullable(),
  accepts_direct_orders: z.boolean(),
  /** In step type order. */
  capabilities: z.array(
    z.strictObject({
      step_type: z.strictObject({ id: z.uuid(), key: z.string(), name: z.string() }),
      /** Pieces per job. */
      min_quantity: z.number().int(),
      max_quantity: z.number().int().nullable(),
      /** The largest side of a piece's bounding box, in millimetres. */
      max_size_mm: z.string().nullable(),
      /** Pieces per `capacity_period`. */
      capacity: z.number().int(),
      capacity_period: z.enum(CAPACITY_PERIODS),
    }),
  ),
  /** Both dates included; earliest first. */
  closed_periods: z.array(z.strictObject({ starts_on: z.iso.date(), ends_on: z.iso.date(), note: z.string().nullable() })),
  offerings: z.array(
    z.strictObject({ option_value_id: z.uuid(), group_key: z.string(), key: z.string(), name: z.string() }),
  ),
});
export type PartnerSetupResponse = z.infer<typeof partnerSetupResponseSchema>;

/** A partner's price list: the same step prices as the workspace's, in step type order, each step's default first. */
export const partnerPricesResponseSchema = z.strictObject({ data: z.array(stepPriceResponseSchema) });
export type PartnerPricesResponse = z.infer<typeof partnerPricesResponseSchema>;

/** An invitation to act for a partner; the token goes only to the invitee's inbox. */
export const partnerInvitationResponseSchema = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  role: z.enum(PARTNER_ROLES),
  expires_at: z.iso.datetime(),
});
export type PartnerInvitationResponse = z.infer<typeof partnerInvitationResponseSchema>;

/** A person who acts for a partner, with their role there. */
export const partnerMemberResponseSchema = z.strictObject({
  user_id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: z.enum(PARTNER_ROLES),
  /** The person's own status; deactivated people cannot log in. */
  status: z.enum(['active', 'deactivated']),
});
export type PartnerMemberResponse = z.infer<typeof partnerMemberResponseSchema>;

export const partnerMembersResponseSchema = z.strictObject({ data: z.array(partnerMemberResponseSchema) });

/** A partner person and the partners they act for, with their role and each partner's status. */
export const partnerMeResponseSchema = z.strictObject({
  user: z.strictObject({ id: z.uuid(), name: z.string(), email: z.string() }),
  partners: z.array(
    z.strictObject({
      id: z.uuid(),
      display_name: z.string(),
      role: z.enum(PARTNER_ROLES),
      /** A suspended partner can still be read, but not changed. */
      status: z.enum(PARTNER_STATUSES),
    }),
  ),
});
export type PartnerMeResponse = z.infer<typeof partnerMeResponseSchema>;
