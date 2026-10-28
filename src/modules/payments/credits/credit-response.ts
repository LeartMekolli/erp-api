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

/** Credits staff give by hand: whole, with the last day they can be used and a reason. */
export const grantCreditsSchema = z.strictObject({
  amount: z.number().int().min(1).max(1_000_000),
  /** The last day the credits can be used, in the workspace's time zone; today at the earliest. */
  expires_on: z.iso.date(),
  reason: z.string().trim().min(1).max(500),
});
export type GrantCredits = z.infer<typeof grantCreditsSchema>;
