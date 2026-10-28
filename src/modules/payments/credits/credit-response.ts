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

/** Credits staff give by hand: whole, with the last day they can be used and a reason. */
export const grantCreditsSchema = z.strictObject({
  amount: z.number().int().min(1).max(1_000_000),
  /** The last day the credits can be used, in the workspace's time zone; today at the earliest. */
  expires_on: z.iso.date(),
  reason: z.string().trim().min(1).max(500),
});
export type GrantCredits = z.infer<typeof grantCreditsSchema>;
