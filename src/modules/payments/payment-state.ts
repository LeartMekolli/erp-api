import { Prisma } from '../../generated/prisma/client';

// An order's payment state, derived from its frozen terms and the ledger, never stored (Payments spec).

export const PAYMENT_TERMS = ['pay_first', 'pay_later'] as const;
export type PaymentTerms = (typeof PAYMENT_TERMS)[number];

export const PAYMENT_STATES = [
  'awaiting_payment',
  'paid',
  'not_billed',
  'invoiced',
  'overdue',
  'refunded',
  'partly_refunded',
  'none',
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const INVOICE_STATUSES = ['open', 'paid', 'void'] as const;

export interface PaymentFacts {
  terms: PaymentTerms;
  cancelled: boolean;
  /** Production has started (`production_started_at` is set). */
  started: boolean;
  /** Money received for the order. */
  paid: Prisma.Decimal;
  /** Refunds that succeeded. */
  refunded: Prisma.Decimal;
  invoice: { status: (typeof INVOICE_STATUSES)[number]; dueOn: string } | null;
  /** The workspace's date today, as YYYY-MM-DD. */
  today: string;
}

/** The first rule that matches wins. */
export function paymentState(facts: PaymentFacts): PaymentState {
  const { paid, refunded, invoice } = facts;
  if (paid.gt(0) && refunded.gte(paid)) return 'refunded';
  if (refunded.gt(0)) return 'partly_refunded';
  if (paid.gt(0)) return 'paid';
  if (facts.cancelled) return 'none';
  if (invoice?.status === 'open') return invoice.dueOn < facts.today ? 'overdue' : 'invoiced';
  if (!facts.started) return 'awaiting_payment';
  return 'not_billed';
}

/** Where money arrives and leaves: a payment debits one of them, a refund credits one. */
const CASH_ACCOUNTS: ReadonlySet<string> = new Set(['stripe_balance', 'outside_stripe']);

/**
 * What was paid and refunded, from an order's `payment_received` and `refund` journals: the
 * movement on the cash accounts. Other journals are ignored.
 */
export function paidAndRefunded(journals: { kind: string; lines: { account: string; amount: Prisma.Decimal }[] }[]): {
  paid: Prisma.Decimal;
  refunded: Prisma.Decimal;
} {
  let paid = new Prisma.Decimal(0);
  let refunded = new Prisma.Decimal(0);
  for (const journal of journals) {
    const cash = journal.lines
      .filter((line) => CASH_ACCOUNTS.has(line.account))
      .reduce((sum, line) => sum.add(line.amount), new Prisma.Decimal(0));
    if (journal.kind === 'payment_received') paid = paid.add(cash);
    if (journal.kind === 'refund') refunded = refunded.sub(cash);
  }
  return { paid, refunded };
}
