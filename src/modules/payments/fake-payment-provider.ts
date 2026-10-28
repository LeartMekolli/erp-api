import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { InvalidSignatureError, ProviderRefusedError } from './payment-provider';
import type { PaymentProvider, ProviderEvent, ProviderKeys, ProviderPayment } from './payment-provider';

type PartnerAccountState = 'onboarding' | 'ready' | 'restricted';

interface FakeCheckout {
  amount: Prisma.Decimal;
  status: 'open' | 'complete' | 'expired';
  paymentId: string | null;
}
interface FakePrice {
  productId: string;
  amount: Prisma.Decimal;
  currency: string;
  interval: 'month' | 'year';
}
interface FakeInvoice {
  amount: Prisma.Decimal;
  status: 'open' | 'paid' | 'void';
  paidOutside: boolean;
  paymentId: string | null;
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
        this.checkouts.set(id, { amount: input.amount, status: 'open', paymentId: null });
        return { id, url: `https://fake.pay.test/checkout/${id}` };
      }),
    );
  }

  getCheckout(_keys: ProviderKeys, id: string): Promise<ProviderPayment & { status: 'open' | 'complete' | 'expired' }> {
    const checkout = this.must(this.checkouts, id);
    const paid = checkout.status === 'complete';
    return Promise.resolve({
      status: checkout.status,
      paid,
      amount: checkout.amount,
      fee: paid ? fee(checkout.amount) : new Prisma.Decimal(0),
      paymentId: checkout.paymentId,
    });
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
        this.invoices.set(id, { amount, status: 'open', paidOutside: false, paymentId: null });
        const due = new Date(Date.now() + input.daysUntilDue * 86_400_000);
        return { id, url: `https://fake.pay.test/invoice/${id}`, dueOn: due.toISOString().slice(0, 10) };
      }),
    );
  }

  getInvoice(_keys: ProviderKeys, id: string): Promise<ProviderPayment & { status: 'open' | 'paid' | 'void' }> {
    const invoice = this.must(this.invoices, id);
    const paid = invoice.status === 'paid';
    return Promise.resolve({
      status: invoice.status,
      paid,
      amount: invoice.amount,
      fee: paid && !invoice.paidOutside ? fee(invoice.amount) : new Prisma.Decimal(0),
      paymentId: invoice.paymentId,
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
    if (found === undefined) throw new Error(`Unknown fake object ${id}`);
    return found;
  }

  private mac(signed: string, secret: string): string {
    return createHmac('sha256', secret).update(signed).digest('hex');
  }
}
