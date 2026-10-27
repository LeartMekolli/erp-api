import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination/page';
import type { Prisma } from '../../generated/prisma/client';
import { orderPaymentResponseSchema } from '../orders/order-response';
import { ACCOUNTS, JOURNAL_KINDS } from './ledger';
import { PAYMENT_TERMS } from './payment-state';

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

export const DEFAULT_DAYS_TO_PAY = 30;

export const setPaymentTermsSchema = z.strictObject({
  terms: z.enum(PAYMENT_TERMS),
  /** Days an invoice gives to pay. */
  days_to_pay: z.number().int().min(1).max(120).default(DEFAULT_DAYS_TO_PAY),
  /** What a pay-later customer may owe at once; left out or null: no limit. */
  credit_limit: z
    .string()
    .regex(/^\d{1,16}(\.\d{1,2})?$/, 'must be an amount of zero or more with at most 2 places, such as 5000.00')
    .nullable()
    .default(null),
});
export type SetPaymentTerms = z.infer<typeof setPaymentTermsSchema>;

/** A customer's payment terms, as staff see them; never shown to the customer. */
export const paymentTermsResponseSchema = z.strictObject({
  terms: z.enum(PAYMENT_TERMS),
  days_to_pay: z.number().int(),
  credit_limit: z.string().nullable(),
});
export type PaymentTermsResponse = z.infer<typeof paymentTermsResponseSchema>;

/** A customer without a row pays first, within the default days, with no limit. */
export function paymentTermsResponse(
  row: { terms: string; daysToPay: number; creditLimit: Prisma.Decimal | null } | null,
): PaymentTermsResponse {
  return {
    terms: (row?.terms ?? 'pay_first') as PaymentTermsResponse['terms'],
    days_to_pay: row?.daysToPay ?? DEFAULT_DAYS_TO_PAY,
    credit_limit: row?.creditLimit?.toFixed(2) ?? null,
  };
}

/** Where the customer pays for a waiting order. */
export const payLinkResponseSchema = z.strictObject({ url: z.string() });
export type PayLinkResponse = z.infer<typeof payLinkResponseSchema>;

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

/** One checkout of a pay-first order, as staff see it. */
export const checkoutResponseSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['open', 'complete', 'expired']),
  amount: z.string(),
  currency: z.string().length(3),
  /** Null until the provider has answered, or when it never did. */
  url: z.string().nullable(),
  expires_at: z.iso.datetime(),
  created_at: z.iso.datetime(),
});
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;

/** Everything about how an order is paid, for staff: its state, its checkouts and its journals. */
export const orderPaymentsResponseSchema = z.strictObject({
  payment: orderPaymentResponseSchema,
  /** Oldest first. */
  checkouts: z.array(checkoutResponseSchema),
  /** Newest first, each with its lines. */
  journals: z.array(ledgerJournalResponseSchema),
});
export type OrderPaymentsResponse = z.infer<typeof orderPaymentsResponseSchema>;
