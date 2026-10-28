import { Prisma } from '../../generated/prisma/client';
import { FakePaymentProvider } from './fake-payment-provider';
import { InvalidSignatureError, ProviderRefusedError } from './payment-provider';
import type { ProviderKeys } from './payment-provider';

const keys: ProviderKeys = { secretKey: 'sk_test_fake' };
const checkoutInput = (idempotencyKey: string) => ({
  amount: new Prisma.Decimal('100.00'),
  currency: 'EUR',
  description: 'Order 1',
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  successUrl: 'https://shop.test/ok',
  cancelUrl: 'https://shop.test/no',
  metadata: { order_id: 'o1' },
  idempotencyKey,
});

/** `from` plus `months`, on the same day or the month's last when it is shorter, as Stripe counts a period. */
function plusMonths(from: Date, months: number): Date {
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), last));
  target.setUTCHours(from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds());
  return target;
}

describe('FakePaymentProvider', () => {
  it('gives the same checkout for the same idempotency key', async () => {
    const provider = new FakePaymentProvider();

    const first = await provider.createCheckout(keys, checkoutInput('k1'));
    const again = await provider.createCheckout(keys, checkoutInput('k1'));
    const other = await provider.createCheckout(keys, checkoutInput('k2'));

    expect(again).toEqual(first);
    expect(other.id).not.toBe(first.id);
    expect(first.id).toMatch(/^fake_checkout_\d+$/);
  });

  it('reports a completed checkout as paid, with a fee of 2.9% + 0.30', async () => {
    const provider = new FakePaymentProvider();
    // Every instance shares one store, so each test uses keys of its own.
    const { id } = await provider.createCheckout(keys, checkoutInput('k3'));

    expect(await provider.getCheckout(keys, id)).toMatchObject({ status: 'open', paid: false });

    provider.completeCheckout(id);
    const done = await provider.getCheckout(keys, id);

    expect(done.status).toBe('complete');
    expect(done.paid).toBe(true);
    expect(done.amount.toFixed(2)).toBe('100.00');
    expect(done.fee.toFixed(2)).toBe('3.20');
    expect(done.paymentId).not.toBeNull();
  });

  it('expires a checkout, and expiring a finished one is not an error', async () => {
    const provider = new FakePaymentProvider();
    const { id } = await provider.createCheckout(keys, checkoutInput('k4'));

    await provider.expireCheckout(keys, id);
    await provider.expireCheckout(keys, id);

    expect((await provider.getCheckout(keys, id)).status).toBe('expired');
  });

  it('verifies what sign produced, as Stripe formats it', () => {
    const provider = new FakePaymentProvider();
    const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

    const event = provider.verifyEvent(Buffer.from(body), provider.sign(body, 'whsec_a'), 'whsec_a');

    expect(event).toEqual({ id: 'evt_1', type: 'checkout.session.completed', objectId: 'cs_1', connectedAccountId: null });
  });

  it('reads the connected account of an event', () => {
    const provider = new FakePaymentProvider();
    const body = JSON.stringify({ id: 'evt_2', type: 'account.updated', account: 'acct_9', data: { object: { id: 'acct_9' } } });

    const event = provider.verifyEvent(Buffer.from(body), provider.sign(body, 'whsec_a'), 'whsec_a');

    expect(event.connectedAccountId).toBe('acct_9');
  });

  it('refuses a changed body, a wrong secret and a malformed header', () => {
    const provider = new FakePaymentProvider();
    const body = JSON.stringify({ id: 'evt_1', type: 't', data: { object: { id: 'x' } } });
    const header = provider.sign(body, 'whsec_a');

    expect(() => provider.verifyEvent(Buffer.from(body + ' '), header, 'whsec_a')).toThrow(InvalidSignatureError);
    expect(() => provider.verifyEvent(Buffer.from(body), header, 'whsec_b')).toThrow(InvalidSignatureError);
    expect(() => provider.verifyEvent(Buffer.from(body), 'nonsense', 'whsec_a')).toThrow(InvalidSignatureError);
  });

  it('makes a product once per key and recurring prices on it', async () => {
    const provider = new FakePaymentProvider();

    const product = await provider.ensureProduct(keys, { name: 'Pro', idempotencyKey: 'plan-1' });
    const again = await provider.ensureProduct(keys, { name: 'Pro', idempotencyKey: 'plan-1' });
    const monthly = await provider.createPrice(keys, {
      productId: product.id,
      amount: new Prisma.Decimal('29.00'),
      currency: 'EUR',
      interval: 'month',
      idempotencyKey: 'price-1',
    });
    const sameKey = await provider.createPrice(keys, {
      productId: product.id,
      amount: new Prisma.Decimal('29.00'),
      currency: 'EUR',
      interval: 'month',
      idempotencyKey: 'price-1',
    });

    expect(again).toEqual(product);
    expect(product.id).toMatch(/^fake_product_\d+$/);
    expect(sameKey).toEqual(monthly);
    expect(monthly.id).toMatch(/^fake_price_\d+$/);
    expect(provider.price(monthly.id)).toEqual({
      productId: product.id,
      amount: new Prisma.Decimal('29.00'),
      currency: 'EUR',
      interval: 'month',
    });
  });

  it('sells a subscription through a checkout, active for one interval and its first invoice paid', async () => {
    const provider = new FakePaymentProvider();
    const product = await provider.ensureProduct(keys, { name: 'Pro', idempotencyKey: 'plan-sub-1' });
    const price = await provider.createPrice(keys, {
      productId: product.id,
      amount: new Prisma.Decimal('29.00'),
      currency: 'EUR',
      interval: 'month',
      idempotencyKey: 'price-sub-1',
    });
    const input = {
      providerCustomerId: 'fake_customer_x',
      priceId: price.id,
      successUrl: 'https://shop.test/billing?subscription=done',
      cancelUrl: 'https://shop.test/billing?subscription=cancelled',
      metadata: { customer_id: 'c1' },
      idempotencyKey: 'sub-checkout-1',
    };

    const checkout = await provider.createSubscriptionCheckout(keys, input);
    expect(await provider.createSubscriptionCheckout(keys, input)).toEqual(checkout);
    expect(await provider.getCheckout(keys, checkout.id)).toMatchObject({ status: 'open', paid: false, subscriptionId: null });

    const before = Date.now();
    const { subscriptionId, invoiceId } = provider.completeSubscriptionCheckout(checkout.id);

    expect(await provider.getCheckout(keys, checkout.id)).toMatchObject({ status: 'complete', paid: true, subscriptionId });
    const subscription = await provider.getSubscription(keys, subscriptionId);
    expect(subscription).toMatchObject({
      status: 'active',
      priceId: price.id,
      providerCustomerId: 'fake_customer_x',
      metadata: { customer_id: 'c1' },
      cancelAtPeriodEnd: false,
      scheduledPriceId: null,
    });
    expect(subscription.currentPeriodStart.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const nextMonth = plusMonths(subscription.currentPeriodStart, 1);
    expect(subscription.currentPeriodEnd).toEqual(nextMonth);
    expect(provider.subscription(subscriptionId)).toEqual(subscription);

    const invoice = await provider.getInvoice(keys, invoiceId);
    expect(invoice).toMatchObject({
      status: 'paid',
      paid: true,
      subscriptionId,
      reason: 'create',
      periodStart: subscription.currentPeriodStart,
      periodEnd: nextMonth,
    });
    expect(invoice.amount.toFixed(2)).toBe('29.00');
    expect(invoice.fee.toFixed(2)).toBe('1.14');
  });

  it('changes a subscription by test control, and links to the billing portal', async () => {
    const provider = new FakePaymentProvider();
    const product = await provider.ensureProduct(keys, { name: 'Pro', idempotencyKey: 'plan-sub-2' });
    const price = await provider.createPrice(keys, {
      productId: product.id,
      amount: new Prisma.Decimal('290.00'),
      currency: 'EUR',
      interval: 'year',
      idempotencyKey: 'price-sub-2',
    });
    const checkout = await provider.createSubscriptionCheckout(keys, {
      providerCustomerId: 'fake_customer_y',
      priceId: price.id,
      successUrl: 'https://shop.test/ok',
      cancelUrl: 'https://shop.test/no',
      metadata: {},
      idempotencyKey: 'sub-checkout-2',
    });
    const { subscriptionId } = provider.completeSubscriptionCheckout(checkout.id);
    const start = provider.subscription(subscriptionId).currentPeriodStart;
    expect(provider.subscription(subscriptionId).currentPeriodEnd).toEqual(plusMonths(start, 12));

    provider.setSubscriptionStatus(subscriptionId, 'past_due');

    expect((await provider.getSubscription(keys, subscriptionId)).status).toBe('past_due');
    expect((await provider.billingPortalLink(keys, { providerCustomerId: 'fake_customer_y', returnUrl: 'https://shop.test/billing' })).url).toMatch(
      /^https:\/\/fake\.pay\.test\/billing\//,
    );
  });

  describe('changing a subscription', () => {
    /** A subscription active on a monthly price of `amount`, with another price to move to. */
    async function subscribed(tag: string, amount = '29.00', other = '99.00') {
      const provider = new FakePaymentProvider();
      const product = await provider.ensureProduct(keys, { name: 'Plan', idempotencyKey: `plan-${tag}` });
      const price = (value: string, key: string) =>
        provider.createPrice(keys, {
          productId: product.id,
          amount: new Prisma.Decimal(value),
          currency: 'EUR',
          interval: 'month',
          idempotencyKey: `${key}-${tag}`,
        });
      const current = await price(amount, 'current');
      const next = await price(other, 'next');
      const checkout = await provider.createSubscriptionCheckout(keys, {
        providerCustomerId: `fake_customer_${tag}`,
        priceId: current.id,
        successUrl: 'https://shop.test/ok',
        cancelUrl: 'https://shop.test/no',
        metadata: {},
        idempotencyKey: `checkout-${tag}`,
      });
      const { subscriptionId } = provider.completeSubscriptionCheckout(checkout.id);
      return { provider, subscriptionId, current: current.id, next: next.id };
    }

    it('moves to the upgraded price only once its invoice is paid', async () => {
      const { provider, subscriptionId, current, next } = await subscribed('up');

      await provider.upgradeSubscription(keys, subscriptionId, { priceId: next, idempotencyKey: 'up-1' });
      expect(provider.subscription(subscriptionId).priceId).toBe(current);

      const { invoiceId } = provider.settleUpgrade(subscriptionId, true);

      expect(provider.subscription(subscriptionId)).toMatchObject({ priceId: next, status: 'active' });
      const invoice = await provider.getInvoice(keys, invoiceId);
      expect(invoice).toMatchObject({ status: 'paid', subscriptionId, reason: 'update' });
      expect(invoice.amount.toFixed(2)).toBe('70.00');
    });

    it('keeps the old price when the upgrade is not paid, its invoice left open', async () => {
      const { provider, subscriptionId, current, next } = await subscribed('up-unpaid');

      await provider.upgradeSubscription(keys, subscriptionId, { priceId: next, idempotencyKey: 'up-2' });
      const { invoiceId } = provider.settleUpgrade(subscriptionId, false);

      expect(provider.subscription(subscriptionId)).toMatchObject({ priceId: current, status: 'active' });
      expect(await provider.getInvoice(keys, invoiceId)).toMatchObject({ status: 'open', paid: false, reason: 'update' });
    });

    it('moves to a scheduled price at renewal, and a removed schedule changes nothing', async () => {
      const { provider, subscriptionId, current, next } = await subscribed('down', '99.00', '29.00');
      const end = provider.subscription(subscriptionId).currentPeriodEnd;

      await provider.scheduleSubscriptionPrice(keys, subscriptionId, { priceId: next, idempotencyKey: 'down-1' });
      expect(provider.subscription(subscriptionId)).toMatchObject({ priceId: current, scheduledPriceId: next });
      await provider.scheduleSubscriptionPrice(keys, subscriptionId, { priceId: null, idempotencyKey: 'down-2' });
      expect(provider.subscription(subscriptionId).scheduledPriceId).toBeNull();
      await provider.scheduleSubscriptionPrice(keys, subscriptionId, { priceId: next, idempotencyKey: 'down-3' });

      const { invoiceId } = provider.renew(subscriptionId, true);

      expect(provider.subscription(subscriptionId)).toMatchObject({ priceId: next, scheduledPriceId: null, status: 'active', currentPeriodStart: end });
      const invoice = await provider.getInvoice(keys, invoiceId!);
      expect(invoice).toMatchObject({ status: 'paid', reason: 'cycle' });
      expect(invoice.amount.toFixed(2)).toBe('29.00');
    });

    it('ends a subscription cancelled at the period end on renewal, with no invoice', async () => {
      const { provider, subscriptionId } = await subscribed('cancel');

      await provider.setCancelAtPeriodEnd(keys, subscriptionId, true);
      expect(provider.subscription(subscriptionId).cancelAtPeriodEnd).toBe(true);

      expect(provider.renew(subscriptionId, true)).toEqual({ invoiceId: null });
      expect(provider.subscription(subscriptionId).status).toBe('ended');
    });

    it('is past due when a renewal is not paid, and ends when the provider gives up', async () => {
      const { provider, subscriptionId } = await subscribed('late');

      const { invoiceId } = provider.renew(subscriptionId, false);

      expect(provider.subscription(subscriptionId).status).toBe('past_due');
      expect(await provider.getInvoice(keys, invoiceId!)).toMatchObject({ status: 'open', reason: 'cycle' });
      provider.giveUp(subscriptionId);
      expect(provider.subscription(subscriptionId).status).toBe('ended');
    });
  });

  it('has no subscription on an order checkout or an order invoice', async () => {
    const provider = new FakePaymentProvider();
    const { id } = await provider.createCheckout(keys, checkoutInput('k-sub-none'));
    const invoice = await provider.createInvoice(keys, {
      providerCustomerId: 'fake_customer_z',
      currency: 'EUR',
      lines: [{ description: 'Ring', amount: new Prisma.Decimal('100.00') }],
      tax: new Prisma.Decimal('19.00'),
      daysUntilDue: 30,
      metadata: {},
      idempotencyKey: 'inv-sub-none',
    });

    expect((await provider.getCheckout(keys, id)).subscriptionId).toBeNull();
    expect(await provider.getInvoice(keys, invoice.id)).toMatchObject({ subscriptionId: null, reason: null, periodStart: null, periodEnd: null });
  });

  it('refuses one transfer after failNextTransfer, then works again', async () => {
    const provider = new FakePaymentProvider();
    const input = (idempotencyKey: string) => ({
      destination: 'acct_1',
      amount: new Prisma.Decimal('30.00'),
      currency: 'EUR',
      description: 'Payout',
      idempotencyKey,
    });

    provider.failNextTransfer('balance_insufficient');

    await expect(provider.transfer(keys, input('t1'))).rejects.toThrow(ProviderRefusedError);
    await expect(provider.transfer(keys, input('t1'))).resolves.toMatchObject({ id: expect.stringMatching(/^fake_transfer_/) });
  });
});
