import { Prisma } from '../../generated/prisma/client';
import { buildJournal, creditAppliedJournal, planCreditedJournal } from './ledger';
import type { JournalDraft } from './ledger';

const d = (value: string) => new Prisma.Decimal(value);
const lines = (draft: JournalDraft) => draft.entries.map((entry) => [entry.account, entry.amount.toFixed(2), entry.customerId]);
const sum = (draft: JournalDraft) => draft.entries.reduce((total, entry) => total.add(entry.amount), d('0')).toFixed(2);

describe('plan journals', () => {
  it('gives back a negative plan invoice as the customer credit at the provider', () => {
    const draft = planCreditedJournal('c', d('166.00'));

    expect(draft.kind).toBe('plan_credited');
    expect(lines(draft)).toEqual([
      ['subscription_sales', '166.00', 'c'],
      ['customer_credit', '-166.00', 'c'],
    ]);
    expect(sum(draft)).toBe('0.00');
  });

  it('pays a plan invoice from that credit, without cash', () => {
    const draft = creditAppliedJournal('c', d('99.00'));

    expect(draft.kind).toBe('credit_applied');
    expect(lines(draft)).toEqual([
      ['customer_credit', '99.00', 'c'],
      ['customer_receivable', '-99.00', 'c'],
    ]);
    expect(sum(draft)).toBe('0.00');
  });
});

describe('buildJournal', () => {
  it('accepts an order billed for 119.00, with 100.00 of sales and 19.00 of tax', () => {
    const draft = buildJournal('order_billed', [
      { account: 'customer_receivable', amount: d('119.00') },
      { account: 'sales', amount: d('-100.00') },
      { account: 'tax_payable', amount: d('-19.00') },
    ]);

    expect(draft.kind).toBe('order_billed');
    expect(draft.entries.map((entry) => entry.account)).toEqual(['customer_receivable', 'sales', 'tax_payable']);
  });

  it('refuses a journal that is off by one cent', () => {
    expect(() =>
      buildJournal('order_billed', [
        { account: 'customer_receivable', amount: d('119.01') },
        { account: 'sales', amount: d('-100.00') },
        { account: 'tax_payable', amount: d('-19.00') },
      ]),
    ).toThrow(/balance/i);
  });

  it('refuses a journal with one line, or none', () => {
    expect(() => buildJournal('payment_received', [{ account: 'stripe_balance', amount: d('10.00') }])).toThrow(/two/i);
    expect(() => buildJournal('payment_received', [])).toThrow(/two/i);
  });

  it('refuses a line of zero', () => {
    expect(() =>
      buildJournal('payment_received', [
        { account: 'stripe_balance', amount: d('10.00') },
        { account: 'customer_receivable', amount: d('-10.00') },
        { account: 'provider_fees', amount: d('0.00') },
      ]),
    ).toThrow(/zero/i);
  });
});
