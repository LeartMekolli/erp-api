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

const partnerRefSchema = z.strictObject({ id: z.uuid(), name: z.string() });

/** Staff only: who can take a job, cheapest first, and who can't, with why. */
export const eligiblePartnersResponseSchema = z.strictObject({
  data: z.array(
    z.strictObject({
      partner: partnerRefSchema,
      /** What the partner would be paid for the job. */
      cost: z.string(),
      /** The quote's total less the partner's cost. */
      margin: z.string(),
      /** Pieces the partner would still have room for at each of its steps, in path order, after this job. */
      room: z.array(z.strictObject({ step_key: z.string(), left: z.number().int() })),
      /** The partner's overall score out of 5; null for now, until scores exist. */
      score: z.number().nullable(),
    }),
  ),
  ineligible: z.array(z.strictObject({ partner: partnerRefSchema, reasons: z.array(z.string()) })),
});
export type EligiblePartnersResponse = z.infer<typeof eligiblePartnersResponseSchema>;

export const ASSIGNMENT_KINDS = ['offer', 'direct', 'reassign'] as const;
export const ASSIGNMENT_STATUSES = ['offered', 'accepted', 'declined', 'expired', 'withdrawn', 'replaced'] as const;

/** A job handed to a partner. Holds no customer, quote or customer price, so partners may see it. */
export const jobAssignmentResponseSchema = z.strictObject({
  id: z.uuid(),
  group_id: z.uuid(),
  partner: partnerRefSchema,
  kind: z.enum(ASSIGNMENT_KINDS),
  status: z.enum(ASSIGNMENT_STATUSES),
  /** What the partner is paid for the job, frozen when it was handed over. */
  cost: z.string(),
  /** An amount staff set instead, with why. */
  owed_override: z.strictObject({ amount: z.string(), reason: z.string() }).nullable(),
  /** When an offer lapses; null when there was no offer. */
  expires_at: z.iso.datetime().nullable(),
  responded_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
});
export type JobAssignmentResponse = z.infer<typeof jobAssignmentResponseSchema>;

/** Every time a job was handed to a partner, oldest first. */
export const jobHistoryResponseSchema = z.strictObject({ data: z.array(jobAssignmentResponseSchema) });
export type JobHistoryResponse = z.infer<typeof jobHistoryResponseSchema>;

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
