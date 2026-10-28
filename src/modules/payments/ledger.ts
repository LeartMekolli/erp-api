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
] as const;
export type Account = (typeof ACCOUNTS)[number];

export const JOURNAL_KINDS = ['order_billed', 'payment_received', 'provider_fee', 'refund', 'payout', 'reversal'] as const;
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

/** The customer paid `amount`, which arrived on `cash`. */
export function receivedJournal(customerId: string, amount: Prisma.Decimal, cash: 'stripe_balance' | 'outside_stripe'): JournalDraft {
  return buildJournal('payment_received', [
    { account: cash, amount },
    { account: 'customer_receivable', amount: amount.neg(), customerId },
  ]);
}

/** The provider kept `fee` of a payment. */
export function feeJournal(fee: Prisma.Decimal): JournalDraft {
  return buildJournal('provider_fee', [
    { account: 'provider_fees', amount: fee },
    { account: 'stripe_balance', amount: fee.neg() },
  ]);
}
