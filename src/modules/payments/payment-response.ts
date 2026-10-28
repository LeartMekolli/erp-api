import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Prisma } from '../../generated/prisma/client';
import { orderPaymentResponseSchema } from '../orders/order-response';
import { PAYOUT_ACCOUNT_STATES } from '../partners/partner-response';
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

/** Why staff let an order held for its credit limit through. */
export const releaseOrderSchema = z.strictObject({ reason: z.string().trim().min(1).max(500) });
export type ReleaseOrder = z.infer<typeof releaseOrderSchema>;

/** A payment made outside the provider, such as a bank transfer, as staff record it. */
export const paidByHandSchema = z.strictObject({
  reference: z.string().trim().min(1).max(200).describe('Where to find the payment, such as the bank transfer reference.'),
  received_on: z.iso.date().describe("The day it arrived; not after today in the workspace's timezone."),
});
export type PaidByHand = z.infer<typeof paidByHandSchema>;

export const refundSuggestionQuerySchema = z.object({
  lines: z
    .string()
    .regex(/^\d{1,3}(,\d{1,3}){0,49}$/, 'must be line positions separated by commas, such as 0,1')
    .optional()
    .describe('The positions of the lines to cancel; every line left when left out.'),
});
export type RefundSuggestionQuery = z.infer<typeof refundSuggestionQuerySchema>;

/** What to refund if the lines were cancelled now: their price with tax, less the work partners are owed for. */
export const refundSuggestionResponseSchema = z.strictObject({
  suggested: z.string().describe('Never more than `paid_left`, never below 0.00.'),
  work_done: z.string().describe('What partners are owed now for work on these lines; in-house work counts as 0.00.'),
  paid_left: z.string().describe('What was paid and is neither refunded nor being refunded.'),
});
export type RefundSuggestionResponse = z.infer<typeof refundSuggestionResponseSchema>;

/** One invoice of the customer's, open or overdue. */
export const customerInvoiceResponseSchema = z.strictObject({
  order_id: z.uuid(),
  order_number: z.number().int(),
  total: z.string(),
  currency: z.string().length(3),
  due_on: z.iso.date(),
  url: z.string().nullable(),
});

/** A customer's money, as staff see it: its terms, what it owes and its invoices. */
export const paymentCustomerResponseSchema = paymentTermsResponseSchema.extend({
  exposure: z
    .string()
    .describe('What the customer owes or will owe: billed and not paid, plus its started pay-later orders not billed yet.'),
  balance: z.string().describe('Billed and not paid, from the ledger.'),
  /** Open and not due yet. Oldest due first. */
  open_invoices: z.array(customerInvoiceResponseSchema),
  /** Open and past due. Oldest due first. */
  overdue_invoices: z.array(customerInvoiceResponseSchema),
});
export type PaymentCustomerResponse = z.infer<typeof paymentCustomerResponseSchema>;

/** A partner's payout account, as staff and the partner see it: never the provider's id. */
export const payoutAccountResponseSchema = z.strictObject({ state: z.enum(PAYOUT_ACCOUNT_STATES) });
export type PayoutAccountResponse = z.infer<typeof payoutAccountResponseSchema>;

/** Where the partner sets up or finishes its payout account at the provider; each link works once, until it expires. */
export const payoutLinkResponseSchema = z.strictObject({ url: z.string(), expires_at: z.iso.datetime() });
export type PayoutLinkResponse = z.infer<typeof payoutLinkResponseSchema>;

/** One transfer to a partner of what was due, with what it holds for each job; never the order behind a job. */
export const payoutResponseSchema = z.strictObject({
  id: z.uuid(),
  partner_id: z.uuid(),
  amount: z.string(),
  currency: z.string().length(3),
  /** `pending` until the provider has made the transfer; `failed` or `reversed` gives its jobs back to be paid again. */
  status: z.enum(['pending', 'paid', 'failed', 'reversed']),
  /** Why the provider refused the transfer. */
  failure: z.string().nullable(),
  created_at: z.iso.datetime(),
  settled_at: z.iso.datetime().nullable(),
  jobs: z.array(
    z.strictObject({
      assignment_id: z.uuid(),
      group_id: z.uuid(),
      product: z.strictObject({ name: z.string() }).nullable(),
      quantity: z.number().int(),
      /** Negative when the payout takes back what an earlier one paid for the job. */
      amount: z.string(),
    }),
  ),
});
export type PayoutResponse = z.infer<typeof payoutResponseSchema>;

/** A partner's payouts, newest first, a page at a time. */
export const payoutPageResponseSchema = pageSchema(payoutResponseSchema);
export type PayoutPageResponse = z.infer<typeof payoutPageResponseSchema>;

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
