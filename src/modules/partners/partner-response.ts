import { z } from 'zod';
import { pageSchema } from '../../common/pagination/page';
import { stepPriceResponseSchema } from '../pricing/pricing-response';
import { quotePriceSchema } from '../pricing/quote-response';
import { actionResponseSchema, moveHistoryResponseSchema } from '../workflow/move-history-response';
import { WORK_ORDER_STATUSES, lastMoveSchema, transitionResponseSchema } from '../workflow/work-order-response';
import { OUTCOMES, checklistItemSchema } from '../workflow/workflow-config';
import { jobSummaryResponseSchema } from './job-summary-response';
import { PARTNER_STAGES } from './partner-stage';
import { PARTNER_ROLES } from './partner-roles';

// What clients receive for partners; checked against real responses in the e2e tests.

export const PARTNER_STATUSES = ['setting_up', 'approved', 'suspended'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

/** A partner's account at the payment provider, which it is paid through (Payments spec). */
export const PAYOUT_ACCOUNT_STATES = ['not_connected', 'onboarding', 'ready', 'restricted'] as const;
export type PayoutAccountState = (typeof PAYOUT_ACCOUNT_STATES)[number];

/** Each part a share from 0 to 1 over the last 90 days; null when there is nothing to go on. */
const scorePartSchema = z.number().min(0).max(1).nullable();

/**
 * A partner's score (Partners spec, goal 15), for staff and the partner itself; customers see only
 * `overall`. Derived on read from the partner's moves, offers and ratings.
 */
export const partnerScoreSchema = z.strictObject({
  /** Out of 5, to one decimal: the workspace's weighted mix of the parts. Null ("new") until 5 jobs are finished. */
  overall: z.number().nullable(),
  parts: z.strictObject({
    /** Pieces that passed each of the partner's steps first time. */
    quality: scorePartSchema,
    /** One less the share of pieces scrapped. */
    scrap: scorePartSchema,
    /** Offers accepted, rather than declined or left to expire. */
    reliability: scorePartSchema,
    /** The share of jobs with a due date finished by it, among those finished or past due; null with none. */
    on_time: scorePartSchema,
    /** Customers' stars, 1 to 5 as 0 to 1. */
    rating: scorePartSchema,
    /** One less the share of the pieces it made that were claimed at its fault (Orders 3 spec, goal 6). */
    claims: scorePartSchema,
  }),
  /** Jobs the partner has finished, ever. */
  finished_jobs: z.number().int(),
});
export type PartnerScore = z.infer<typeof partnerScoreSchema>;

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
  score: partnerScoreSchema,
  /** Whether the partner can be paid through the payment provider. */
  payout_account: z.enum(PAYOUT_ACCOUNT_STATES),
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

/** A partner's load and capacity per step type, one row per day it was kept: oldest day first, then step type order. */
export const capacityHistoryResponseSchema = z.strictObject({
  data: z.array(
    z.strictObject({
      date: z.iso.date(),
      step_type: z.strictObject({ id: z.uuid(), key: z.string(), name: z.string() }),
      /** Pieces offered to or accepted by the partner that still had the step ahead of them. */
      load: z.number().int(),
      /** Pieces per `capacity_period`, as the partner had it that day. */
      capacity: z.number().int(),
      capacity_period: z.enum(CAPACITY_PERIODS),
    }),
  ),
});
export type CapacityHistoryResponse = z.infer<typeof capacityHistoryResponseSchema>;

/** The agreement a partner signed, as its own people see it, with a short-lived link to the file. */
export const partnerAgreementResponseSchema = z.strictObject({
  file_version_id: z.uuid(),
  signed_on: z.iso.date(),
  /** The file's name as uploaded. */
  name: z.string(),
  url: z.string(),
  expires_at: z.iso.datetime(),
});
export type PartnerAgreementResponse = z.infer<typeof partnerAgreementResponseSchema>;

/** A partner's price for a step, as staff see it. */
export const partnerPriceResponseSchema = stepPriceResponseSchema.extend({
  /** Copied from the workspace's own price and not changed since; the partner doesn't see its numbers. */
  copied_from_workspace: z.boolean(),
});

/** Staff: a partner's price list, the same step prices as the workspace's, in step type order, each step's default first. */
export const partnerPricesResponseSchema = z.strictObject({ data: z.array(partnerPriceResponseSchema) });
export type PartnerPricesResponse = z.infer<typeof partnerPricesResponseSchema>;

/**
 * The partner's own view of its price list: the prices it set, and which steps are priced at the
 * workspace's rates, whose numbers it never sees (Global Constraints, the author 2026-10-25).
 */
export const portalPricesResponseSchema = z.strictObject({
  data: z.array(stepPriceResponseSchema),
  copied: z.array(z.strictObject({ step_type_id: z.uuid(), material_id: z.uuid().nullable() })),
});
export type PortalPricesResponse = z.infer<typeof portalPricesResponseSchema>;

const partnerRefSchema = z.strictObject({ id: z.uuid(), name: z.string() });

/** Staff only: who can take a job, best score first, then cheapest, and who can't, with why. */
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
      score: partnerScoreSchema,
    }),
  ),
  ineligible: z.array(z.strictObject({ partner: partnerRefSchema, reasons: z.array(z.string()) })),
});
export type EligiblePartnersResponse = z.infer<typeof eligiblePartnersResponseSchema>;

export const ASSIGNMENT_KINDS = ['offer', 'direct', 'reassign'] as const;
export const ASSIGNMENT_STATUSES = ['offered', 'accepted', 'declined', 'expired', 'withdrawn', 'replaced', 'cancelled'] as const;

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
  /** The day the job should be done by; null for a job that isn't an order line and was given none. */
  due_on: z.iso.date().nullable(),
  created_at: z.iso.datetime(),
});
export type JobAssignmentResponse = z.infer<typeof jobAssignmentResponseSchema>;

export const PARTNER_JOB_STATUSES = ['offered', 'accepted', 'finished'] as const;

/**
 * A job as its partner sees it: what to make, its own steps and what it is paid. Never the customer,
 * the quote or the customer's price (plan Review Focus 2).
 */
export const partnerJobResponseSchema = z.strictObject({
  /** The job's id: its work order group. */
  id: z.uuid(),
  /** Offered and waiting for an answer, accepted and in production, or finished: no piece left to make. */
  status: z.enum(PARTNER_JOB_STATUSES),
  offered_at: z.iso.datetime(),
  /** When an offer lapses; null for a job handed over without one. */
  expires_at: z.iso.datetime().nullable(),
  /** The day the job should be done by; null when it has none. */
  due_on: z.iso.date().nullable(),
  product: z.strictObject({ name: z.string() }).nullable(),
  /** The chosen options, by name, in option order. */
  options: z.array(z.strictObject({ group: z.string(), value: z.string() })),
  quantity: z.number().int(),
  /** The design to make; download it from the job's `design` route. */
  design_file_version_id: z.uuid().nullable(),
  /** The partner's own steps, in order, with each step's instructions. */
  steps: z.array(z.strictObject({ key: z.string(), name: z.string(), sop_file_version_id: z.uuid().nullable() })),
  /** What the partner is paid for the job. */
  cost: z.string(),
  pieces: z.strictObject({ active: z.number().int(), finished: z.number().int(), scrapped: z.number().int() }),
});
export type PartnerJobResponse = z.infer<typeof partnerJobResponseSchema>;

/** A page of the partner's jobs, newest hand-over first. */
export const partnerJobsResponseSchema = pageSchema(partnerJobResponseSchema);

const evidenceSchema = z.strictObject({ min_photos: z.number().int(), comment_required: z.boolean() });

export const PARTNER_ACTORS = ['own', 'workspace', 'other_partner'] as const;
export type PartnerActor = (typeof PARTNER_ACTORS)[number];

/** Who made a move, as a partner reads it: `own`, one of its people, named; `workspace`: staff; `other_partner`: another partner's people. */
export const partnerActorSchema = z.strictObject({ kind: z.enum(PARTNER_ACTORS), name: z.string().nullable() });

/** A piece's latest move, as a partner reads who made it. */
export const partnerLastMoveSchema = lastMoveSchema.omit({ actor: true, partner: true }).extend({ actor: partnerActorSchema });

/**
 * A move of a piece as a partner reads it: as staff see it, but `comment`, `override_reason` and each
 * answer's `note` only on moves its own people made, else null. No user ids and no partner.
 */
export const partnerTransitionResponseSchema = transitionResponseSchema.omit({ actor: true, partner: true }).extend({ actor: partnerActorSchema });
export type PartnerTransitionResponse = z.infer<typeof partnerTransitionResponseSchema>;

/** One piece of a job the partner holds, with every move it has had, from before the hand-over too. */
export const partnerWorkOrderResponseSchema = z.strictObject({
  id: z.uuid(),
  /** Such as 3/10. */
  label: z.string(),
  status: z.enum(WORK_ORDER_STATUSES),
  /** Where the piece is now; null once it is finished, scrapped or cancelled. */
  step: z.strictObject({ key: z.string(), name: z.string() }).nullable(),
  /** Null unless the piece is active at one of the partner's steps that samples; else whether it must be inspected in full. */
  to_inspect: z.boolean().nullable(),
  /** Being redone after a failed check; false once the piece is finished, scrapped or cancelled. */
  in_rework: z.boolean(),
  /** Every step the piece goes through, in order, the workspace's own included: names only. */
  path: z.array(z.strictObject({ key: z.string(), name: z.string() })),
  /** Every move of the piece, oldest first; photos download from the job's `moves/{move_id}/photos` route. */
  history: z.array(partnerTransitionResponseSchema),
});
export type PartnerWorkOrderResponse = z.infer<typeof partnerWorkOrderResponseSchema>;

/**
 * One of the partner's steps with what its QC gate asks for, so the partner can pass and fail pieces.
 * Never the workspace's own steps' rules, nor staff settings such as the skill a step needs.
 */
export const partnerStepRulesSchema = z.strictObject({
  key: z.string(),
  name: z.string(),
  /** Download it from the step's `sop` route. */
  sop_file_version_id: z.uuid().nullable(),
  checklist: z.array(checklistItemSchema),
  /** The defects a fail may name, with what happens to the piece. */
  defects: z.array(
    z.strictObject({
      id: z.uuid(),
      key: z.string(),
      name: z.string(),
      outcome: z.enum(OUTCOMES),
      /** The step a rework goes back to; null for a scrap or a continue. */
      rework_to: z.string().nullable(),
    }),
  ),
  /** The steps a failed piece may go back to, the workspace's own included. */
  rework_targets: z.array(z.strictObject({ key: z.string(), name: z.string() })),
  pass: evidenceSchema,
  fail: evidenceSchema,
  /** Inspect only `inspect` of every `of_every` pieces; null when every piece is inspected. */
  sampling: z.strictObject({ inspect: z.number().int(), of_every: z.number().int() }).nullable(),
});
export type PartnerStepRules = z.infer<typeof partnerStepRulesSchema>;

/**
 * One of the partner's steps on a job: its QC rules, the active pieces there now, and its checks since the
 * job came to the partner. `passed` and `failed` count moves, not pieces, so a piece that fails and then
 * passes counts once in each; `not_inspected` is the part of `passed` left out of a sample. On a job only
 * offered, the checks are empty.
 */
export const partnerJobStepSchema = partnerStepRulesSchema.extend({
  count: z.number().int(),
  in_rework: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  not_inspected: z.number().int(),
  /** The defects of the step's fails, most frequent first, then by name (staff's `defects`; here `defects` are the rules). */
  defect_counts: z.array(z.strictObject({ key: z.string(), name: z.string(), count: z.number().int() })),
  /** The latest inspected pass or fail; its photos download from the job's `moves/{move_id}/photos` route. */
  latest_check: z
    .strictObject({
      move_id: z.uuid(),
      actor: partnerActorSchema,
      created_at: z.iso.datetime(),
      photos: z.array(z.strictObject({ file_id: z.uuid(), file_version_id: z.uuid() })),
    })
    .nullable(),
});

/** A job with its steps' QC rules and quality, and each of its pieces, so the partner knows which to move and how. */
export const partnerJobDetailResponseSchema = partnerJobResponseSchema.extend({
  /** The partner's own steps, in order. */
  steps: z.array(partnerJobStepSchema),
  work_orders: z.array(
    z.strictObject({
      id: z.uuid(),
      /** Such as 3/10. */
      label: z.string(),
      status: z.enum(['active', 'finished', 'scrapped']),
      /** The step the piece is at; null once it is finished or scrapped. */
      step_key: z.string().nullable(),
      /** Null unless the piece is active at one of the partner's steps that samples; else whether it must be inspected in full. */
      to_inspect: z.boolean().nullable(),
      /** Being redone after a failed check; false once the piece is finished or scrapped. */
      in_rework: z.boolean(),
      /** Null until the piece first moves, and on a job the partner has only been offered. */
      last_move: partnerLastMoveSchema.nullable(),
      /**
       * `yours`: at one of the partner's steps; `not_yet`: at a workspace step with a partner step still to
       * come; `done`: past the partner's last step; null once finished or scrapped.
       */
      stage: z.enum(PARTNER_STAGES).nullable(),
    }),
  ),
  /** The AI's brief of the job (Orders 3 spec, goal 15); null when none was written. */
  summary: jobSummaryResponseSchema,
});
export type PartnerJobDetailResponse = z.infer<typeof partnerJobDetailResponseSchema>;

/**
 * The workshops a customer may pick for a configuration, each at the price the customer would pay with
 * it. Never what a workshop costs, its own name, or why others are missing (Global Constraints).
 */
export const partnerChoicesResponseSchema = z.strictObject({
  data: z.array(
    z.strictObject({
      partner: z.strictObject({ id: z.uuid(), display_name: z.string() }),
      /** The workshop's overall score out of 5; null for a new workshop. Never its parts. */
      score: z.number().nullable(),
      price: quotePriceSchema,
    }),
  ),
});
export type PartnerChoicesResponse = z.infer<typeof partnerChoicesResponseSchema>;

/**
 * What a partner is owed for one hand-over of a job (Partners spec, goal 14): owed once every live piece
 * has passed the payout step, or at once for a partner replaced mid-way (P16).
 */
export const owedJobResponseSchema = z.strictObject({
  assignment_id: z.uuid(),
  /** The job's id: its work order group. */
  group_id: z.uuid(),
  product: z.strictObject({ name: z.string() }).nullable(),
  quantity: z.number().int(),
  /** `not_yet` until every live piece has passed the payout step. */
  state: z.enum(['not_yet', 'owed']),
  /** What is owed, or will be: the cost frozen at the hand-over, or what staff set instead. */
  amount: z.string(),
  /** Why staff set the amount; null when it is the cost. */
  override_reason: z.string().nullable(),
  /** What payouts have paid for the job, or are paying. */
  paid: z.string(),
  /** What the next payout pays for it: owed now less `paid`; negative when more was paid than is owed now. */
  due: z.string(),
  /** Whether the customer has paid for the job's order; null when the job is not from an order. Staff only. */
  customer_paid: z.boolean().nullable(),
});
export type OwedJobResponse = z.infer<typeof owedJobResponseSchema>;

/**
 * What staff see a partner is owed: a page of hand-overs, newest first; `total` counts only what is
 * owed now, across every page.
 */
export const partnerOwedResponseSchema = z.strictObject({
  total: z.string(),
  jobs: z.array(owedJobResponseSchema),
  next_cursor: z.string().nullable(),
});
export type PartnerOwedResponse = z.infer<typeof partnerOwedResponseSchema>;

/** What a partner sees it is owed: the same, without staff's reasons. */
export const portalOwedResponseSchema = z.strictObject({
  total: z.string(),
  jobs: z.array(owedJobResponseSchema.omit({ override_reason: true, customer_paid: true })),
  next_cursor: z.string().nullable(),
});
export type PortalOwedResponse = z.infer<typeof portalOwedResponseSchema>;

/** A customer's rating of a finished job, as staff see it: who rated it and every comment. */
export const ratingResponseSchema = z.strictObject({
  id: z.uuid(),
  group_id: z.uuid(),
  partner: partnerRefSchema,
  customer: z.strictObject({ id: z.uuid(), name: z.string() }),
  stars: z.number().int().min(1).max(5),
  comment: z.string().nullable(),
  /** The partner may read the comment, never who wrote it. */
  shared_with_partner: z.boolean(),
  created_at: z.iso.datetime(),
});
export type RatingResponse = z.infer<typeof ratingResponseSchema>;

/** A page of a partner's ratings, newest first. */
export const partnerRatingsResponseSchema = pageSchema(ratingResponseSchema);
export type PartnerRatingsResponse = z.infer<typeof partnerRatingsResponseSchema>;

/** A rating as the customer who gave it sees it. */
export const customerRatingResponseSchema = z.strictObject({
  id: z.uuid(),
  group_id: z.uuid(),
  stars: z.number().int(),
  comment: z.string().nullable(),
  created_at: z.iso.datetime(),
});
export type CustomerRatingResponse = z.infer<typeof customerRatingResponseSchema>;

/**
 * A partner's own score, parts and stars, newest rating first. A comment only once staff share it, and
 * never anything naming the customer (P15).
 */
export const partnerScoreResponseSchema = z.strictObject({
  score: partnerScoreSchema,
  ratings: z.array(
    z.strictObject({
      id: z.uuid(),
      group_id: z.uuid(),
      stars: z.number().int(),
      /** Null unless staff shared it. */
      comment: z.string().nullable(),
      created_at: z.iso.datetime(),
    }),
  ),
});
export type PartnerScoreResponse = z.infer<typeof partnerScoreResponseSchema>;

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

/** A comment on a job the partner holds: what staff wrote on it while it held it and what it wrote, never the customer or the order. */
export const partnerJobCommentResponseSchema = z.strictObject({
  id: z.uuid(),
  body: z.string(),
  /** The workspace is never named; the partner's own people are. */
  author: z.strictObject({ kind: z.enum(['workspace', 'partner']), name: z.string().nullable() }),
  attachments: z.array(z.strictObject({ file_version_id: z.uuid(), name: z.string() })),
  created_at: z.string(),
});
export type PartnerJobCommentResponse = z.infer<typeof partnerJobCommentResponseSchema>;


/**
 * A move on a job the partner holds, as staff see it but for who made it and what they wrote: names,
 * `comment`, `override_reason` and each answer's `note` show only on moves the partner's own people made,
 * else null. No user ids, and no partner: it is this one or nobody.
 */
export const partnerActionResponseSchema = actionResponseSchema.omit({ actor: true, partner: true }).extend({
  actor: partnerActorSchema,
});
export type PartnerActionResponse = z.infer<typeof partnerActionResponseSchema>;

export const partnerMoveHistoryResponseSchema = z.strictObject({
  data: z.array(partnerActionResponseSchema),
  next_cursor: z.string().nullable(),
  /** The job's actions over every page: all of them, and those `only=fails` keeps. */
  counts: moveHistoryResponseSchema.shape.counts,
  /** When the job came to the partner: it accepted the offer, or else staff handed or moved it over. */
  handed_over_at: z.iso.datetime(),
});
export type PartnerMoveHistoryResponse = z.infer<typeof partnerMoveHistoryResponseSchema>;
