import { Prisma } from '../../generated/prisma/client';

/** The starting chart of accounts (Payments spec, goal 9). */
export const ACCOUNTS = [
  'customer_receivable',
  'stripe_balance',
  'outside_stripe',
  'sales',
  'tax_payable',
  'provider_fees',
  'partner_costs',
  // Plans and credit packs (Payments 2 spec), apart from what orders sell.
  'subscription_sales',
  'credit_sales',
  // What the provider holds for a customer as its balance, owed to it: a credit is negative.
  'customer_credit',
] as const;
export type Account = (typeof ACCOUNTS)[number];

export const JOURNAL_KINDS = [
  'order_billed',
  'payment_received',
  'provider_fee',
  'refund',
  'payout',
  'reversal',
  'plan_billed',
  'pack_billed',
  'plan_credited',
  'credit_applied',
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

/** Debit positive, credit negative. */
export interface JournalEntry {
  account: Account;
  amount: Prisma.Decimal;
  customerId?: string;
  partnerId?: string;
}

export interface JournalDraft {
  kind: JournalKind;
  entries: JournalEntry[];
}

/**
 * A journal that can be posted: at least two lines, none of zero, summing to exactly zero. The
 * database refuses anything else at commit; this fails earlier, with the reason.
 */
export function buildJournal(kind: JournalKind, entries: JournalEntry[]): JournalDraft {
  if (entries.length < 2) {
    throw new Error('A journal needs at least two lines');
  }
  if (entries.some((entry) => entry.amount.isZero())) {
    throw new Error('A journal line cannot be zero');
  }
  const total = entries.reduce((sum, entry) => sum.add(entry.amount), new Prisma.Decimal(0));
  if (!total.isZero()) {
    throw new Error(`The journal does not balance: its lines sum to ${total.toFixed(2)}`);
  }
  return { kind, entries };
}

/** The customer is billed `total`: `tax` of it is owed as tax, the rest is sales. */
export function billedJournal(customerId: string, total: Prisma.Decimal, tax: Prisma.Decimal): JournalDraft {
  return buildJournal('order_billed', [
    { account: 'customer_receivable', amount: total, customerId },
    { account: 'sales', amount: total.sub(tax).neg(), customerId },
    ...(tax.isZero() ? [] : [{ account: 'tax_payable' as const, amount: tax.neg(), customerId }]),
  ]);
}

/** The customer is billed `amount` for a period of its plan. No tax yet (Payments 2 spec, non-goals). */
export function planBilledJournal(customerId: string, amount: Prisma.Decimal): JournalDraft {
  return buildJournal('plan_billed', [
    { account: 'customer_receivable', amount, customerId },
    { account: 'subscription_sales', amount: amount.neg(), customerId },
  ]);
}

/**
 * A plan invoice below zero (a move to a cheaper plan mid-period): `amount` of what the plan was paid
 * is given back as the customer's balance at the provider, which pays its next invoices.
 */
export function planCreditedJournal(customerId: string, amount: Prisma.Decimal): JournalDraft {
  return buildJournal('plan_credited', [
    { account: 'subscription_sales', amount, customerId },
    { account: 'customer_credit', amount: amount.neg(), customerId },
  ]);
}

/** `amount` of an invoice paid from the customer's balance at the provider, not by a payment. */
export function creditAppliedJournal(customerId: string, amount: Prisma.Decimal): JournalDraft {
  return buildJournal('credit_applied', [
    { account: 'customer_credit', amount, customerId },
    { account: 'customer_receivable', amount: amount.neg(), customerId },
  ]);
}

/** The customer is billed `amount` for a credit pack. No tax yet (Payments 2 spec, non-goals). */
export function packBilledJournal(customerId: string, amount: Prisma.Decimal): JournalDraft {
  return buildJournal('pack_billed', [
    { account: 'customer_receivable', amount, customerId },
    { account: 'credit_sales', amount: amount.neg(), customerId },
  ]);
}

/** The customer paid `amount`, which arrived on `cash`. */
export function receivedJournal(customerId: string, amount: Prisma.Decimal, cash: 'stripe_balance' | 'outside_stripe'): JournalDraft {
  return buildJournal('payment_received', [
    { account: cash, amount },
    { account: 'customer_receivable', amount: amount.neg(), customerId },
  ]);
}

/**
 * A refund of `amount`, as two journals: sales and tax payable give back their share of it to the
 * receivable, then the receivable is paid out of `cash`.
 */
export function refundJournals(
  customerId: string,
  amount: Prisma.Decimal,
  tax: Prisma.Decimal,
  cash: 'stripe_balance' | 'outside_stripe',
): [JournalDraft, JournalDraft] {
  return [
    buildJournal('refund', [
      { account: 'sales', amount: amount.sub(tax), customerId },
      ...(tax.isZero() ? [] : [{ account: 'tax_payable' as const, amount: tax, customerId }]),
      { account: 'customer_receivable', amount: amount.neg(), customerId },
    ]),
    buildJournal('refund', [
      { account: 'customer_receivable', amount, customerId },
      { account: cash, amount: amount.neg() },
    ]),
  ];
}

/** The provider kept `fee` of a payment. */
export function feeJournal(fee: Prisma.Decimal): JournalDraft {
  return buildJournal('provider_fee', [
    { account: 'provider_fees', amount: fee },
    { account: 'stripe_balance', amount: fee.neg() },
  ]);
}
