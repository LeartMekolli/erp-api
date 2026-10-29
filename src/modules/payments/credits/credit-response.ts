import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../../common/pagination/page';
import { CREDIT_ENTRY_KINDS, GRANT_SOURCES } from './credit-ledger';

const credits = z.number().int();

/** A customer's usable credits now: in total, per source, and per grant in the order they are spent. */
export const creditBalanceResponseSchema = z.strictObject({
  total: credits,
  by_source: z.strictObject({ campaign: credits, staff: credits, allowance: credits, pack: credits }),
  grants: z.array(
    z.strictObject({
      id: z.uuid(),
      source: z.enum(GRANT_SOURCES),
      remaining: credits,
      expires_at: z.iso.datetime(),
    }),
  ),
});
export type CreditBalanceResponse = z.infer<typeof creditBalanceResponseSchema>;

/** One movement of credits: positive for a grant or a give-back, negative for a spend or an expiry. */
export const creditEntryResponseSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(CREDIT_ENTRY_KINDS),
  amount: credits,
  source: z.enum(GRANT_SOURCES),
  reason: z.string().nullable(),
  occurred_at: z.iso.datetime(),
});
export type CreditEntryResponse = z.infer<typeof creditEntryResponseSchema>;

export const creditHistoryResponseSchema = pageSchema(creditEntryResponseSchema);
export const creditHistoryQuerySchema = paginationQuerySchema;
export type CreditHistoryQuery = z.infer<typeof creditHistoryQuerySchema>;

const PRICE = /^\d{1,16}(\.\d{1,2})?$/;

/** A pack's price: above zero, at most 2 places. */
const packPriceSchema = z
  .string()
  .regex(PRICE, 'must be an amount above zero with at most 2 places, such as 10.00')
  .refine((value) => !PRICE.test(value) || Number(value) > 0, 'must be greater than 0');

const packFields = {
  name: z.string().trim().min(1).max(200),
  credits: z.number().int().min(1).max(1_000_000),
  price: packPriceSchema,
  /** How long the credits last from payment. */
  valid_days: z.number().int().min(1).max(3650),
  position: z.number().int().min(0).max(1000),
};

/** A pack of credits, sold once at its price in the workspace's currency. */
export const createCreditPackSchema = z.strictObject({ ...packFields, position: packFields.position.default(0) });
export type CreateCreditPack = z.infer<typeof createCreditPackSchema>;

/** Anything about a pack; a purchase already made keeps what it was sold as. `archived` stops selling it. */
export const updateCreditPackSchema = z.strictObject({
  name: packFields.name.optional(),
  credits: packFields.credits.optional(),
  price: packFields.price.optional(),
  valid_days: packFields.valid_days.optional(),
  position: packFields.position.optional(),
  status: z.enum(['active', 'archived']).optional(),
});
export type UpdateCreditPack = z.infer<typeof updateCreditPackSchema>;

export const creditPackResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  credits: z.number().int(),
  price: z.string(),
  currency: z.string(),
  valid_days: z.number().int(),
  position: z.number().int(),
  status: z.enum(['active', 'archived']),
});
export type CreditPackResponse = z.infer<typeof creditPackResponseSchema>;

export const creditPackListResponseSchema = z.strictObject({ data: z.array(creditPackResponseSchema) });
export type CreditPackListResponse = z.infer<typeof creditPackListResponseSchema>;

export const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'ended'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

const campaignTargetsSchema = z.strictObject({
  /** Every customer on these plans, the free default plan included. */
  plan_ids: z.array(z.uuid()).max(100).default([]),
  /** These customers, whatever their plan. */
  customer_ids: z.array(z.uuid()).max(1000).default([]),
});

const campaignFields = {
  name: z.string().trim().min(1).max(200),
  credits_per_customer: z.number().int().min(1).max(1_000_000),
  /** How long a customer's credits last from the grant. */
  credit_days: z.number().int().min(1).max(3650),
  starts_at: z.iso.datetime({ offset: true }),
  ends_at: z.iso.datetime({ offset: true }),
  /** In credits: grants stop when the next customer's no longer fit. */
  budget: z.number().int().min(1).max(1_000_000_000),
  targets: campaignTargetsSchema,
};

/** What a campaign must hold together: an end after its start, room for one grant, and a target. */
export function campaignProblem(campaign: {
  credits_per_customer: number;
  starts_at: string | Date;
  ends_at: string | Date;
  budget: number;
  targets: { plan_ids: string[]; customer_ids: string[] };
}): string | null {
  if (new Date(campaign.ends_at) <= new Date(campaign.starts_at)) return 'ends_at: must be after starts_at';
  if (campaign.budget < campaign.credits_per_customer) return 'budget: must hold at least one grant of credits_per_customer';
  if (campaign.targets.plan_ids.length + campaign.targets.customer_ids.length === 0) return 'targets: name at least one plan or customer';
  return null;
}

/** A campaign starts as a draft; nothing is granted until it is activated. */
export const createCampaignSchema = z.strictObject(campaignFields).superRefine((campaign, ctx) => {
  const problem = campaignProblem(campaign);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
export type CreateCampaign = z.infer<typeof createCampaignSchema>;

/** Anything about a campaign in draft or paused; `targets`, when sent, replaces them all. */
export const updateCampaignSchema = z.strictObject({
  name: campaignFields.name.optional(),
  credits_per_customer: campaignFields.credits_per_customer.optional(),
  credit_days: campaignFields.credit_days.optional(),
  starts_at: campaignFields.starts_at.optional(),
  ends_at: campaignFields.ends_at.optional(),
  budget: campaignFields.budget.optional(),
  targets: campaignTargetsSchema.optional(),
});
export type UpdateCampaign = z.infer<typeof updateCampaignSchema>;

export const campaignResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  credits_per_customer: z.number().int(),
  credit_days: z.number().int(),
  starts_at: z.iso.datetime(),
  ends_at: z.iso.datetime(),
  budget: z.number().int(),
  status: z.enum(CAMPAIGN_STATUSES),
  targets: z.strictObject({ plan_ids: z.array(z.uuid()), customer_ids: z.array(z.uuid()) }),
  /** Customers given its credits, and how many credits that was. */
  granted_customers: z.number().int(),
  granted_credits: z.number().int(),
  /** Of those, what the customers have spent: whether the campaign worked. */
  spent_credits: z.number().int(),
  budget_left: z.number().int(),
  /** When a customer first found no room left. */
  budget_used_at: z.iso.datetime().nullable(),
});
export type CampaignResponse = z.infer<typeof campaignResponseSchema>;

export const campaignListResponseSchema = z.strictObject({ data: z.array(campaignResponseSchema) });
export type CampaignListResponse = z.infer<typeof campaignListResponseSchema>;

/** Credits staff give by hand: whole, with the last day they can be used and a reason. */
export const grantCreditsSchema = z.strictObject({
  amount: z.number().int().min(1).max(1_000_000),
  /** The last day the credits can be used, in the workspace's time zone; today at the earliest. */
  expires_on: z.iso.date(),
  reason: z.string().trim().min(1).max(500),
});
export type GrantCredits = z.infer<typeof grantCreditsSchema>;
