import { Prisma } from '../../generated/prisma/client';
import { billableTotals, paymentState } from './payment-state';
import type { PaymentFacts } from './payment-state';

const d = (value: string) => new Prisma.Decimal(value);

/** A pay-later order in production, nothing paid, refunded or invoiced. */
const facts = (extra: Partial<PaymentFacts> = {}): PaymentFacts => ({
  terms: 'pay_later',
  cancelled: false,
  started: true,
  paid: d('0'),
  refunded: d('0'),
  invoice: null,
  today: '2026-10-15',
  ...extra,
});

describe('paymentState', () => {
  it('is refunded once everything paid has been refunded', () => {
    expect(paymentState(facts({ paid: d('119.00'), refunded: d('119.00') }))).toBe('refunded');
    expect(paymentState(facts({ paid: d('119.00'), refunded: d('119.00'), cancelled: true }))).toBe('refunded');
  });

  it('is partly refunded when some of it has been', () => {
    expect(paymentState(facts({ paid: d('119.00'), refunded: d('50.00') }))).toBe('partly_refunded');
  });

  it('is paid once something is paid, whatever the invoice or the cancellation says', () => {
    expect(paymentState(facts({ paid: d('119.00') }))).toBe('paid');
    expect(paymentState(facts({ paid: d('119.00'), invoice: { status: 'open', dueOn: '2026-10-01' } }))).toBe('paid');
    expect(paymentState(facts({ terms: 'pay_first', paid: d('119.00'), cancelled: true }))).toBe('paid');
  });

  it('is none for a cancelled order with nothing paid', () => {
    expect(paymentState(facts({ cancelled: true }))).toBe('none');
    expect(paymentState(facts({ terms: 'pay_first', started: false, cancelled: true }))).toBe('none');
    expect(paymentState(facts({ cancelled: true, invoice: { status: 'open', dueOn: '2026-10-01' } }))).toBe('none');
  });

  it('is overdue for an open invoice past its due date, and invoiced up to and on that day', () => {
    const invoice = { status: 'open' as const, dueOn: '2026-10-01' };

    expect(paymentState(facts({ invoice, today: '2026-10-02' }))).toBe('overdue');
    expect(paymentState(facts({ invoice, today: '2026-10-01' }))).toBe('invoiced');
    expect(paymentState(facts({ invoice, today: '2026-09-20' }))).toBe('invoiced');
  });

  it('is awaiting payment while a pay-first order has not started', () => {
    expect(paymentState(facts({ terms: 'pay_first', started: false }))).toBe('awaiting_payment');
  });

  it('is not billed for a started order with no invoice yet, or one that was voided', () => {
    expect(paymentState(facts())).toBe('not_billed');
    expect(paymentState(facts({ terms: 'pay_first' }))).toBe('not_billed');
    expect(paymentState(facts({ invoice: { status: 'void', dueOn: '2026-10-01' }, today: '2026-10-02' }))).toBe('not_billed');
  });
});

describe('billableTotals', () => {
  const order = { shippingPrice: d('9.90'), taxPercent: d('19') };

  it('charges the live lines and shipping, with tax on both rounded half up once', () => {
    // (100.00 + 18.05 + 9.90) × 19 % = 24.3105 → 24.31
    const totals = billableTotals(order, [d('100.00'), d('18.05')]);
    expect([totals.lines, totals.shipping, totals.tax, totals.total].map((value) => value.toFixed(2))).toEqual([
      '118.05',
      '9.90',
      '24.31',
      '152.26',
    ]);
  });

  it('charges nothing, not even shipping, once no line is live', () => {
    expect(billableTotals(order, []).total.toFixed(2)).toBe('0.00');
  });
});
