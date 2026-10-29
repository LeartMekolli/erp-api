import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { addMonths } from './credits/allowance-month';
import { InvalidSignatureError, ProviderNotFoundError, ProviderRefusedError } from './payment-provider';
import type {
  InvoiceReason,
  PaymentProvider,
  ProviderEvent,
  ProviderKeys,
  ProviderSubscription,
  ProviderSubscriptionStatus,
} from './payment-provider';

type PartnerAccountState = 'onboarding' | 'ready' | 'restricted';

interface FakeCheckout {
  amount: Prisma.Decimal;
  status: 'open' | 'complete' | 'expired';
  paymentId: string | null;
  metadata: Record<string, string>;
  /** On a subscription's checkout: what completing it subscribes to. */
  subscribes: { priceId: string; providerCustomerId: string; metadata: Record<string, string> } | null;
  subscriptionId: string | null;
}
interface FakePrice {
  productId: string;
  amount: Prisma.Decimal;
  currency: string;
  interval: 'month' | 'year';
}
interface FakeInvoice {
  amount: Prisma.Decimal;
  /** What its payment took when not all of a positive total, the rest coming from the customer's balance. */
  amountPaid: Prisma.Decimal | null;
  status: 'open' | 'paid' | 'void';
  paidOutside: boolean;
  paymentId: string | null;
  subscriptionId: string | null;
  reason: InvoiceReason | null;
  periodStart: Date | null;
  periodEnd: Date | null;
}

/** `from` plus one month or one year, as the provider counts a billing period. */
function periodAfter(from: Date, interval: 'month' | 'year'): Date {
  return addMonths(from, interval === 'year' ? 12 : 1);
}

const fee = (amount: Prisma.Decimal): Prisma.Decimal =>
  amount.mul('0.029').add('0.30').toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/**
 * The fake provider's account, one per process, as Stripe's is one for every caller: the API and an
 * in-process worker each build their own provider, and both must see the same checkouts.
 */
const store = {
  counter: 0,
  transferFailure: null as string | null,
  holdRefund: false,
  byKey: new Map<string, unknown>(),
  checkouts: new Map<string, FakeCheckout>(),
  invoices: new Map<string, FakeInvoice>(),
  accounts: new Map<string, PartnerAccountState>(),
  refunds: new Map<string, 'pending' | 'succeeded' | 'failed'>(),
  transfers: [] as { id: string; destination: string; amount: Prisma.Decimal }[],
  prices: new Map<string, FakePrice>(),
  subscriptions: new Map<string, ProviderSubscription>(),
};

/**
 * In memory and deterministic: for tests and local work, so nothing calls Stripe. Ids are
 * `fake_<kind>_<n>`, the fee is 2.9% + 0.30, and the same idempotency key gives the same
 * object. The `sign` method and the test controls stand in for what Stripe does on its own.
 * Every instance shares one store, so ids never repeat within a process.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';

  private readonly byKey = store.byKey;
  private readonly checkouts = store.checkouts;
  private readonly invoices = store.invoices;
  private readonly accounts = store.accounts;
  private readonly refunds = store.refunds;

  // --- test controls -------------------------------------------------------------------------

  completeCheckout(id: string): void {
    const checkout = this.must(this.checkouts, id);
    checkout.status = 'complete';
    checkout.paymentId = this.nextId('payment');
  }

  expire(id: string): void {
    const checkout = this.must(this.checkouts, id);
    if (checkout.status === 'open') checkout.status = 'expired';
  }

  payInvoice(id: string): void {
    const invoice = this.must(this.invoices, id);
    if (invoice.status === 'void') throw new Error(`${id} is void and can't be paid`);
    invoice.status = 'paid';
    invoice.paymentId = this.nextId('payment');
  }

  /** The transfers made to a connected account, oldest first; a refused one was never made. */
  transfersTo(destination: string): { id: string; amount: Prisma.Decimal }[] {
    return store.transfers.filter((transfer) => transfer.destination === destination).map(({ id, amount }) => ({ id, amount }));
  }

  failNextTransfer(message: string): void {
    store.transferFailure = message;
  }

  /** The next refund stays `pending`, as a bank may keep it, until `settleRefund`. */
  holdNextRefund(): void {
    store.holdRefund = true;
  }

  settleRefund(id: string, status: 'succeeded' | 'failed'): void {
    this.must(this.refunds, id);
    this.refunds.set(id, status);
  }

  /** A price made by `createPrice`. */
  price(id: string): FakePrice {
    return this.must(store.prices, id);
  }

  /**
   * The customer pays a subscription's checkout: the subscription is `active` for one interval from
   * now, and its first invoice is paid.
   */
  completeSubscriptionCheckout(checkoutId: string): { subscriptionId: string; invoiceId: string } {
    const checkout = this.must(this.checkouts, checkoutId);
    if (!checkout.subscribes) throw new Error(`${checkoutId} is not a subscription's checkout`);
    const price = this.price(checkout.subscribes.priceId);
    const start = new Date();
    const end = periodAfter(start, price.interval);
    const subscriptionId = this.nextId('subscription');
    store.subscriptions.set(subscriptionId, {
      status: 'active',
      priceId: checkout.subscribes.priceId,
      providerCustomerId: checkout.subscribes.providerCustomerId,
      metadata: checkout.subscribes.metadata,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: false,
      scheduledPriceId: null,
      pendingPriceId: null,
    });
    const invoiceId = this.subscriptionInvoice(subscriptionId, price.amount, 'create', true, start, end);
    checkout.status = 'complete';
    checkout.paymentId = this.invoices.get(invoiceId)!.paymentId;
    checkout.subscriptionId = subscriptionId;
    return { subscriptionId, invoiceId };
  }

  /** A subscription as the provider holds it now. */
  subscription(id: string): ProviderSubscription {
    return { ...this.must(store.subscriptions, id) };
  }

  setSubscriptionStatus(id: string, status: ProviderSubscriptionStatus): void {
    this.must(store.subscriptions, id).status = status;
  }

  /**
   * The prorated invoice of a pending upgrade, for the difference in price: paid, the upgraded price
   * is current; not paid, the old one stays and the invoice stays open (and the upgrade pending).
   */
  settleUpgrade(id: string, paid: boolean): { invoiceId: string } {
    const subscription = this.must(store.subscriptions, id);
    if (!subscription.pendingPriceId) throw new Error(`${id} has no pending upgrade`);
    const amount = this.price(subscription.pendingPriceId).amount.sub(this.price(subscription.priceId).amount);
    const invoiceId = this.subscriptionInvoice(id, amount, 'update', paid, subscription.currentPeriodStart, subscription.currentPeriodEnd);
    if (paid) {
      subscription.priceId = subscription.pendingPriceId;
      subscription.pendingPriceId = null;
    }
    return { invoiceId };
  }

  /**
   * The next period starts: a subscription cancelled at the period end ends, with no invoice;
   * otherwise a scheduled price takes effect and the period is invoiced. Unpaid, it is past due.
   * `'pending'` is the provider's window before it first charges a renewal (about an hour): the
   * subscription is active in its new period, its invoice still open until `payInvoice`.
   */
  renew(id: string, paid: boolean | 'pending'): { invoiceId: string | null } {
    const subscription = this.must(store.subscriptions, id);
    if (subscription.cancelAtPeriodEnd) {
      subscription.status = 'ended';
      return { invoiceId: null };
    }
    if (subscription.scheduledPriceId) {
      subscription.priceId = subscription.scheduledPriceId;
      subscription.scheduledPriceId = null;
    }
    const price = this.price(subscription.priceId);
    subscription.currentPeriodStart = subscription.currentPeriodEnd;
    subscription.currentPeriodEnd = periodAfter(subscription.currentPeriodStart, price.interval);
    subscription.status = paid === false ? 'past_due' : 'active';
    return {
      invoiceId: this.subscriptionInvoice(
        id,
        price.amount,
        'cycle',
        paid === true,
        subscription.currentPeriodStart,
        subscription.currentPeriodEnd,
      ),
    };
  }

  /**
   * Any invoice of a subscription for its current period, as the provider makes them on its own: a
   * negative total when a change gives money back, or one paid from the customer's balance
   * (`amountPaid` below the total; by default all of a positive total once paid).
   */
  issueInvoice(
    subscriptionId: string,
    input: { total: Prisma.Decimal; reason: InvoiceReason; paid: boolean; amountPaid?: Prisma.Decimal },
  ): { invoiceId: string } {
    const subscription = this.must(store.subscriptions, subscriptionId);
    const invoiceId = this.subscriptionInvoice(
      subscriptionId,
      input.total,
      input.reason,
      input.paid,
      subscription.currentPeriodStart,
      subscription.currentPeriodEnd,
      input.amountPaid ?? null,
    );
    return { invoiceId };
  }

  /** The provider stops retrying a late payment and ends the subscription. */
  giveUp(id: string): void {
    this.must(store.subscriptions, id).status = 'ended';
  }

  setPartnerAccountState(id: string, state: PartnerAccountState): void {
    this.must(this.accounts, id);
    this.accounts.set(id, state);
  }

  /** The `Stripe-Signature` header for `body`, in Stripe's format. */
  sign(body: string, secret: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    return `t=${timestamp},v1=${this.mac(`${timestamp}.${body}`, secret)}`;
  }

  // --- the provider --------------------------------------------------------------------------

  verifyEvent(rawBody: Buffer, signatureHeader: string, signingSecret: string): ProviderEvent {
    const parts = new Map(signatureHeader.split(',').map((part) => part.split('=', 2) as [string, string]));
    const timestamp = parts.get('t');
    const given = parts.get('v1');
    if (!timestamp || !given) throw new InvalidSignatureError();
    const expected = this.mac(`${timestamp}.${rawBody.toString('utf8')}`, signingSecret);
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new InvalidSignatureError();

    let parsed: { id: string; type: string; account?: string; data: { object: { id: string } } };
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as typeof parsed;
    } catch {
      throw new InvalidSignatureError('Unreadable event');
    }
    if (typeof parsed.id !== 'string' || typeof parsed.type !== 'string' || typeof parsed.data?.object?.id !== 'string') {
      throw new InvalidSignatureError('Unreadable event');
    }
    return {
      id: parsed.id,
      type: parsed.type,
      objectId: parsed.data.object.id,
      connectedAccountId: parsed.account ?? null,
    };
  }

  createCheckout(
    _keys: ProviderKeys,
    input: Parameters<PaymentProvider['createCheckout']>[1],
  ): Promise<{ id: string; url: string }> {
    return Promise.resolve(
      this.once(input.idempotencyKey, () => {
        const id = this.nextId('checkout');
        this.checkouts.set(id, {
          amount: input.amount,
          status: 'open',
          paymentId: null,
          metadata: input.metadata,
          subscribes: null,
          subscriptionId: null,
        });
        return { id, url: `https://fake.pay.test/checkout/${id}` };
      }),
    );
  }

  getCheckout(_keys: ProviderKeys, id: string): ReturnType<PaymentProvider['getCheckout']> {
    const checkout = this.must(this.checkouts, id);
    const paid = checkout.status === 'complete';
    return Promise.resolve({
      status: checkout.status,
      paid,
      amount: checkout.amount,
      fee: paid ? fee(checkout.amount) : new Prisma.Decimal(0),
      paymentId: checkout.paymentId,
      subscriptionId: checkout.subscriptionId,
      metadata: { ...checkout.metadata },
    });
  }

  createSubscriptionCheckout(
    _keys: ProviderKeys,
    input: Parameters<PaymentProvider['createSubscriptionCheckout']>[1],
  ): Promise<{ id: string; url: string }> {
    return Promise.resolve(
      this.once(input.idempotencyKey, () => {
        const id = this.nextId('checkout');
        this.checkouts.set(id, {
          amount: this.price(input.priceId).amount,
          status: 'open',
          paymentId: null,
          metadata: input.metadata,
          subscribes: { priceId: input.priceId, providerCustomerId: input.providerCustomerId, metadata: input.metadata },
          subscriptionId: null,
        });
        return { id, url: `https://fake.pay.test/checkout/${id}` };
      }),
    );
  }

  getSubscription(_keys: ProviderKeys, id: string): Promise<ProviderSubscription> {
    return Promise.resolve(this.subscription(id));
  }

  upgradeSubscription(_keys: ProviderKeys, id: string, input: Parameters<PaymentProvider['upgradeSubscription']>[2]): Promise<void> {
    this.price(input.priceId);
    this.must(store.subscriptions, id).pendingPriceId = input.priceId;
    return Promise.resolve();
  }

  /** As the provider does when the upgrade's open invoice is voided: the pending price is dropped. */
  withdrawUpgrade(_keys: ProviderKeys, id: string): Promise<void> {
    const subscription = this.must(store.subscriptions, id);
    if (!subscription.pendingPriceId) return Promise.resolve();
    subscription.pendingPriceId = null;
    for (const invoice of this.invoices.values()) {
      if (invoice.subscriptionId === id && invoice.reason === 'update' && invoice.status === 'open') invoice.status = 'void';
    }
    return Promise.resolve();
  }

  scheduleSubscriptionPrice(
    _keys: ProviderKeys,
    id: string,
    input: Parameters<PaymentProvider['scheduleSubscriptionPrice']>[2],
  ): Promise<void> {
    if (input.priceId) this.price(input.priceId);
    this.must(store.subscriptions, id).scheduledPriceId = input.priceId;
    return Promise.resolve();
  }

  setCancelAtPeriodEnd(_keys: ProviderKeys, id: string, cancel: boolean): Promise<void> {
    this.must(store.subscriptions, id).cancelAtPeriodEnd = cancel;
    return Promise.resolve();
  }

  billingPortalLink(_keys: ProviderKeys, input: Parameters<PaymentProvider['billingPortalLink']>[1]): Promise<{ url: string }> {
    return Promise.resolve({ url: `https://fake.pay.test/billing/${input.providerCustomerId}/${this.nextId('portal')}` });
  }

  expireCheckout(_keys: ProviderKeys, id: string): Promise<void> {
    this.expire(id);
    return Promise.resolve();
  }

  ensureCustomer(_keys: ProviderKeys, input: { idempotencyKey: string }): Promise<{ id: string }> {
    return Promise.resolve(this.once(input.idempotencyKey, () => ({ id: this.nextId('customer') })));
  }

  createInvoice(
    _keys: ProviderKeys,
    input: Parameters<PaymentProvider['createInvoice']>[1],
  ): Promise<{ id: string; url: string; dueOn: string }> {
    return Promise.resolve(
      this.once(input.idempotencyKey, () => {
        const id = this.nextId('invoice');
        const amount = input.lines.reduce((sum, line) => sum.add(line.amount), input.tax);
        this.invoices.set(id, {
          amount,
          amountPaid: null,
          status: 'open',
          paidOutside: false,
          paymentId: null,
          subscriptionId: null,
          reason: null,
          periodStart: null,
          periodEnd: null,
        });
        const due = new Date(Date.now() + input.daysUntilDue * 86_400_000);
        return { id, url: `https://fake.pay.test/invoice/${id}`, dueOn: due.toISOString().slice(0, 10) };
      }),
    );
  }

  getInvoice(_keys: ProviderKeys, id: string): ReturnType<PaymentProvider['getInvoice']> {
    const invoice = this.must(this.invoices, id);
    const paid = invoice.status === 'paid';
    const zero = new Prisma.Decimal(0);
    // Nothing before it is paid; then all of a positive total, unless told otherwise.
    const amountPaid = paid ? (invoice.amountPaid ?? (invoice.amount.gt(0) ? invoice.amount : zero)) : zero;
    return Promise.resolve({
      status: invoice.status,
      paid,
      amount: invoice.amount,
      amountPaid,
      fee: paid && !invoice.paidOutside && amountPaid.gt(0) ? fee(amountPaid) : zero,
      paymentId: invoice.paymentId,
      subscriptionId: invoice.subscriptionId,
      reason: invoice.reason,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
    });
  }

  markInvoicePaidOutside(_keys: ProviderKeys, id: string): Promise<void> {
    const invoice = this.must(this.invoices, id);
    invoice.status = 'paid';
    invoice.paidOutside = true;
    return Promise.resolve();
  }

  refund(
    _keys: ProviderKeys,
    input: { idempotencyKey: string },
  ): Promise<{ id: string; status: 'pending' | 'succeeded' | 'failed' }> {
    return Promise.resolve(
      this.once(input.idempotencyKey, () => {
        const id = this.nextId('refund');
        const status = store.holdRefund ? ('pending' as const) : ('succeeded' as const);
        store.holdRefund = false;
        this.refunds.set(id, status);
        return { id, status };
      }),
    );
  }

  getRefund(_keys: ProviderKeys, id: string): Promise<{ status: 'pending' | 'succeeded' | 'failed' }> {
    return Promise.resolve({ status: this.must(this.refunds, id) });
  }

  createPartnerAccount(_keys: ProviderKeys, input: { idempotencyKey: string }): Promise<{ id: string }> {
    return Promise.resolve(
      this.once(input.idempotencyKey, () => {
        const id = this.nextId('account');
        this.accounts.set(id, 'onboarding');
        return { id };
      }),
    );
  }

  partnerOnboardingLink(
    _keys: ProviderKeys,
    accountId: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    this.must(this.accounts, accountId);
    return Promise.resolve({
      url: `https://fake.pay.test/onboarding/${accountId}/${this.nextId('link')}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  }

  getPartnerAccount(_keys: ProviderKeys, accountId: string): Promise<{ state: PartnerAccountState }> {
    return Promise.resolve({ state: this.must(this.accounts, accountId) });
  }

  ensureProduct(_keys: ProviderKeys, input: Parameters<PaymentProvider['ensureProduct']>[1]): Promise<{ id: string }> {
    return Promise.resolve(this.once(input.idempotencyKey, () => ({ id: this.nextId('product') })));
  }

  createPrice(_keys: ProviderKeys, input: Parameters<PaymentProvider['createPrice']>[1]): Promise<{ id: string }> {
    return Promise.resolve(
      this.once(input.idempotencyKey, () => {
        const id = this.nextId('price');
        store.prices.set(id, { productId: input.productId, amount: input.amount, currency: input.currency, interval: input.interval });
        return { id };
      }),
    );
  }

  transfer(
    _keys: ProviderKeys,
    input: Parameters<PaymentProvider['transfer']>[1],
  ): Promise<{ id: string }> {
    if (store.transferFailure !== null) {
      const message = store.transferFailure;
      store.transferFailure = null;
      return Promise.reject(new ProviderRefusedError(message));
    }
    return Promise.resolve(
      this.once(input.idempotencyKey, () => {
        const id = this.nextId('transfer');
        store.transfers.push({ id, destination: input.destination, amount: input.amount });
        return { id };
      }),
    );
  }

  // --- helpers -------------------------------------------------------------------------------

  private subscriptionInvoice(
    subscriptionId: string,
    amount: Prisma.Decimal,
    reason: InvoiceReason,
    paid: boolean,
    periodStart: Date,
    periodEnd: Date,
    amountPaid: Prisma.Decimal | null = null,
  ): string {
    const id = this.nextId('invoice');
    this.invoices.set(id, {
      amount,
      amountPaid,
      status: paid ? 'paid' : 'open',
      paidOutside: false,
      paymentId: paid ? this.nextId('payment') : null,
      subscriptionId,
      reason,
      periodStart,
      periodEnd,
    });
    return id;
  }

  private nextId(kind: string): string {
    store.counter += 1;
    return `fake_${kind}_${store.counter}`;
  }

  private once<T>(key: string, make: () => T): T {
    if (!this.byKey.has(key)) this.byKey.set(key, make());
    return this.byKey.get(key) as T;
  }

  private must<T>(map: Map<string, T>, id: string): T {
    const found = map.get(id);
    if (found === undefined) throw new ProviderNotFoundError(`Unknown fake object ${id}`);
    return found;
  }

  private mac(signed: string, secret: string): string {
    return createHmac('sha256', secret).update(signed).digest('hex');
  }
}
