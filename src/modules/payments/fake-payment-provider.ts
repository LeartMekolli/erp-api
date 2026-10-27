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
interface FakeInvoice {
  amount: Prisma.Decimal;
  status: 'open' | 'paid' | 'void';
  paidOutside: boolean;
  paymentId: string | null;
}

const fee = (amount: Prisma.Decimal): Prisma.Decimal =>
  amount.mul('0.029').add('0.30').toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/**
 * In memory and deterministic: for tests and local work, so nothing calls Stripe. Ids are
 * `fake_<kind>_<n>`, the fee is 2.9% + 0.30, and the same idempotency key gives the same
 * object. The `sign` method and the test controls stand in for what Stripe does on its own.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';

  private counter = 0;
  private readonly byKey = new Map<string, unknown>();
  private readonly checkouts = new Map<string, FakeCheckout>();
  private readonly invoices = new Map<string, FakeInvoice>();
  private readonly accounts = new Map<string, PartnerAccountState>();
  private readonly refunds = new Map<string, 'pending' | 'succeeded' | 'failed'>();
  private transferFailure: string | null = null;

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

  failNextTransfer(message: string): void {
    this.transferFailure = message;
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
        this.refunds.set(id, 'succeeded');
        return { id, status: 'succeeded' as const };
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

  transfer(
    _keys: ProviderKeys,
    input: Parameters<PaymentProvider['transfer']>[1],
  ): Promise<{ id: string }> {
    if (this.transferFailure !== null) {
      const message = this.transferFailure;
      this.transferFailure = null;
      return Promise.reject(new ProviderRefusedError(message));
    }
    return Promise.resolve(this.once(input.idempotencyKey, () => ({ id: this.nextId('transfer') })));
  }

  // --- helpers -------------------------------------------------------------------------------

  private nextId(kind: string): string {
    this.counter += 1;
    return `fake_${kind}_${this.counter}`;
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
