import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination/page';
import { ACCOUNTS, JOURNAL_KINDS } from './ledger';

const prefixed = (prefixes: string[]) =>
  z
    .string()
    .min(1)
    .max(300)
    .refine((value) => prefixes.some((prefix) => value.startsWith(prefix)), {
      message: `must start with ${prefixes.join(' or ')}`,
    });

/** The workspace's provider keys. The secrets are sealed on arrival and never shown again. */
export const setPaymentAccountSchema = z.strictObject({
  secret_key: prefixed(['sk_', 'rk_']),
  publishable_key: prefixed(['pk_']),
  webhook_secret: prefixed(['whsec_']),
  connect_webhook_secret: prefixed(['whsec_']),
});

export const paymentAccountResponseSchema = z.strictObject({
  configured: z.boolean(),
  publishable_key: z.string().nullable(),
  mode: z.enum(['test', 'live']).nullable().describe('From the secret key: sk_test_ is test, sk_live_ is live.'),
  webhook_urls: z.strictObject({
    payments: z.string().describe('Where the provider sends payment events.'),
    connect: z.string().describe('Where the provider sends events of connected partner accounts.'),
  }),
});
export type PaymentAccountResponse = z.infer<typeof paymentAccountResponseSchema>;

/** What a webhook answers once the event is stored (or was already). */
export const webhookAckResponseSchema = z.strictObject({ received: z.literal(true) });
export type WebhookAckResponse = z.infer<typeof webhookAckResponseSchema>;

export const ledgerQuerySchema = paginationQuerySchema.extend({
  order_id: z.uuid().optional(),
  customer_id: z.uuid().optional(),
  partner_id: z.uuid().optional(),
  from: z.iso.date().optional().describe('Journals from the start of this day (UTC).'),
  to: z.iso.date().optional().describe('Journals up to the end of this day (UTC).'),
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

export const ledgerJournalResponseSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(JOURNAL_KINDS),
  occurred_at: z.iso.datetime(),
  currency: z.string().length(3),
  order_id: z.uuid().nullable(),
  customer_id: z.uuid().nullable(),
  partner_id: z.uuid().nullable(),
  payout_id: z.uuid().nullable(),
  refund_id: z.uuid().nullable(),
  provider_object_id: z.string().nullable(),
  reverses_journal_id: z.uuid().nullable(),
  memo: z.string(),
  lines: z.array(
    z.strictObject({
      account: z.enum(ACCOUNTS),
      amount: z.string().describe('Debit positive, credit negative; the lines of a journal sum to 0.00.'),
      customer_id: z.uuid().nullable(),
      partner_id: z.uuid().nullable(),
    }),
  ),
});
export type LedgerJournalResponse = z.infer<typeof ledgerJournalResponseSchema>;
