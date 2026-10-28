import Stripe from 'stripe';
import { Prisma } from '../../generated/prisma/client';
import { InvalidSignatureError, ProviderNotFoundError, ProviderRefusedError } from './payment-provider';
import type {
  PaymentProvider,
  ProviderEvent,
  ProviderKeys,
  ProviderPayment,
  ProviderSubscription,
  ProviderSubscriptionStatus,
} from './payment-provider';

function fractionDigits(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Whole minor units (cents), rounded half up (ADR 0002). Only this file converts. */
export function toMinorUnits(amount: Prisma.Decimal | string | number, currency: string): number {
  const digits = fractionDigits(currency);
  return new Prisma.Decimal(amount)
    .mul(new Prisma.Decimal(10).pow(digits))
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
}

export function fromMinorUnits(minor: number, currency: string): Prisma.Decimal {
  return new Prisma.Decimal(minor).div(new Prisma.Decimal(10).pow(fractionDigits(currency)));
}

const isoDate = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

const refundStatus = (status: string | null): 'pending' | 'succeeded' | 'failed' =>
  status === 'succeeded' ? 'succeeded' : status === 'failed' || status === 'canceled' ? 'failed' : 'pending';

/** Stripe's subscription statuses, as ours: still owed money counts as past due, never as ended. */
export function subscriptionStatus(status: Stripe.Subscription.Status): ProviderSubscriptionStatus {
  switch (status) {
    case 'trialing':
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'paused':
      return 'past_due';
    case 'incomplete':
      return 'incomplete';
    default:
      return 'ended';
  }
}

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  value == null ? null : typeof value === 'string' ? value : value.id;

/**
 * Stripe, in the workspace's own account (`keys`). Used with test keys only. Never called from tests:
 * only `verifyEvent` and the unit helpers are exercised offline.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';

  private client(keys: ProviderKeys): Stripe {
    return new Stripe(keys.secretKey);
  }

  verifyEvent(rawBody: Buffer, signatureHeader: string, signingSecret: string): ProviderEvent {
    let event: Stripe.Event;
    try {
      event = new Stripe('sk_unused').webhooks.constructEvent(rawBody, signatureHeader, signingSecret);
    } catch (error) {
      throw new InvalidSignatureError(error instanceof Error ? error.message : undefined);
    }
    const object = event.data.object as { id?: string };
    return {
      id: event.id,
      type: event.type,
      objectId: object.id ?? '',
      connectedAccountId: event.account ?? null,
    };
  }

  async createCheckout(
    keys: ProviderKeys,
    input: Parameters<PaymentProvider['createCheckout']>[1],
  ): Promise<{ id: string; url: string }> {
    const session = await this.client(keys).checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: toMinorUnits(input.amount, input.currency),
              product_data: { name: input.description },
            },
          },
        ],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        metadata: input.metadata,
        payment_intent_data: { metadata: input.metadata },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { id: session.id, url: session.url ?? '' };
  }

  async getCheckout(
    keys: ProviderKeys,
    id: string,
  ): Promise<ProviderPayment & { status: 'open' | 'complete' | 'expired'; subscriptionId: string | null }> {
    const stripe = this.client(keys);
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(id);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing') {
        throw new ProviderNotFoundError(error.message);
      }
      throw error;
    }
    const currency = session.currency ?? 'eur';
    const paid = session.payment_status === 'paid';
    const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    return {
      status: session.status === 'complete' ? 'complete' : session.status === 'expired' ? 'expired' : 'open',
      paid,
      amount: fromMinorUnits(session.amount_total ?? 0, currency),
      fee: paid && paymentIntent ? await this.feeOf(stripe, paymentIntent, currency) : new Prisma.Decimal(0),
      paymentId: paymentIntent ?? null,
      subscriptionId: idOf(session.subscription),
    };
  }

  async createSubscriptionCheckout(
    keys: ProviderKeys,
    input: Parameters<PaymentProvider['createSubscriptionCheckout']>[1],
  ): Promise<{ id: string; url: string }> {
    const session = await this.client(keys).checkout.sessions.create(
      {
        mode: 'subscription',
        customer: input.providerCustomerId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: input.metadata,
        subscription_data: { metadata: input.metadata },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { id: session.id, url: session.url ?? '' };
  }

  async getSubscription(keys: ProviderKeys, id: string): Promise<ProviderSubscription> {
    const stripe = this.client(keys);
    const subscription = await stripe.subscriptions.retrieve(id);
    const item = subscription.items.data[0];
    if (!item) throw new Error(`Subscription ${id} has no item`);
    return {
      status: subscriptionStatus(subscription.status),
      priceId: item.price.id,
      providerCustomerId: idOf(subscription.customer) ?? '',
      metadata: subscription.metadata,
      currentPeriodStart: new Date(item.current_period_start * 1000),
      currentPeriodEnd: new Date(item.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      scheduledPriceId: await this.scheduledPrice(stripe, idOf(subscription.schedule), item.current_period_end),
    };
  }

  async billingPortalLink(keys: ProviderKeys, input: { providerCustomerId: string; returnUrl: string }): Promise<{ url: string }> {
    const session = await this.client(keys).billingPortal.sessions.create({ customer: input.providerCustomerId, return_url: input.returnUrl });
    return { url: session.url };
  }

  async expireCheckout(keys: ProviderKeys, id: string): Promise<void> {
    const stripe = this.client(keys);
    const session = await stripe.checkout.sessions.retrieve(id);
    if (session.status === 'open') await stripe.checkout.sessions.expire(id);
  }

  async ensureCustomer(
    keys: ProviderKeys,
    input: { customerId: string; name: string; email: string | null; idempotencyKey: string },
  ): Promise<{ id: string }> {
    const customer = await this.client(keys).customers.create(
      { name: input.name, email: input.email ?? undefined, metadata: { customer_id: input.customerId } },
      { idempotencyKey: input.idempotencyKey },
    );
    return { id: customer.id };
  }

  async createInvoice(
    keys: ProviderKeys,
    input: Parameters<PaymentProvider['createInvoice']>[1],
  ): Promise<{ id: string; url: string; dueOn: string }> {
    const stripe = this.client(keys);
    const currency = input.currency.toLowerCase();
    const draft = await stripe.invoices.create(
      {
        customer: input.providerCustomerId,
        currency,
        collection_method: 'send_invoice',
        days_until_due: input.daysUntilDue,
        auto_advance: false,
        metadata: input.metadata,
      },
      { idempotencyKey: `${input.idempotencyKey}:invoice` },
    );
    const items = [...input.lines, ...(input.tax.gt(0) ? [{ description: 'Tax', amount: input.tax }] : [])];
    for (const [index, item] of items.entries()) {
      await stripe.invoiceItems.create(
        {
          customer: input.providerCustomerId,
          invoice: draft.id,
          currency,
          amount: toMinorUnits(item.amount, input.currency),
          description: item.description,
        },
        { idempotencyKey: `${input.idempotencyKey}:item:${index}` },
      );
    }
    const finalized = await stripe.invoices.finalizeInvoice(
      draft.id,
      { auto_advance: false },
      { idempotencyKey: `${input.idempotencyKey}:finalize` },
    );
    return {
      id: finalized.id,
      url: finalized.hosted_invoice_url ?? '',
      dueOn: isoDate(finalized.due_date ?? Math.floor(Date.now() / 1000) + input.daysUntilDue * 86_400),
    };
  }

  async getInvoice(keys: ProviderKeys, id: string): ReturnType<PaymentProvider['getInvoice']> {
    const stripe = this.client(keys);
    let invoice: Stripe.Invoice;
    try {
      invoice = await stripe.invoices.retrieve(id, { expand: ['payments'] });
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing') {
        throw new ProviderNotFoundError(error.message);
      }
      throw error;
    }
    const paid = invoice.status === 'paid';
    const payment = invoice.payments?.data.find((candidate) => candidate.status === 'paid')?.payment;
    const paymentIntent = payment?.payment_intent;
    const paymentId = typeof paymentIntent === 'string' ? paymentIntent : (paymentIntent?.id ?? null);
    const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription);
    // The invoice's own period is the one before; its lines carry the period they pay for.
    const periods = subscriptionId ? invoice.lines.data.map((line) => line.period) : [];
    return {
      status: paid ? 'paid' : invoice.status === 'void' ? 'void' : 'open',
      paid,
      amount: fromMinorUnits(invoice.total, invoice.currency),
      fee: paid && paymentId ? await this.feeOf(stripe, paymentId, invoice.currency) : new Prisma.Decimal(0),
      paymentId,
      subscriptionId,
      periodStart: periods.length > 0 ? new Date(Math.min(...periods.map((period) => period.start)) * 1000) : null,
      periodEnd: periods.length > 0 ? new Date(Math.max(...periods.map((period) => period.end)) * 1000) : null,
    };
  }

  async markInvoicePaidOutside(keys: ProviderKeys, id: string): Promise<void> {
    await this.client(keys).invoices.pay(id, { paid_out_of_band: true });
  }

  async refund(
    keys: ProviderKeys,
    input: { paymentId: string; amount: Prisma.Decimal; idempotencyKey: string },
  ): Promise<{ id: string; status: 'pending' | 'succeeded' | 'failed' }> {
    const stripe = this.client(keys);
    const intent = await stripe.paymentIntents.retrieve(input.paymentId);
    const refund = await stripe.refunds.create(
      { payment_intent: input.paymentId, amount: toMinorUnits(input.amount, intent.currency) },
      { idempotencyKey: input.idempotencyKey },
    );
    return { id: refund.id, status: refundStatus(refund.status) };
  }

  async getRefund(keys: ProviderKeys, id: string): Promise<{ status: 'pending' | 'succeeded' | 'failed' }> {
    return { status: refundStatus((await this.client(keys).refunds.retrieve(id)).status) };
  }

  async ensureProduct(keys: ProviderKeys, input: { name: string; idempotencyKey: string }): Promise<{ id: string }> {
    const product = await this.client(keys).products.create({ name: input.name }, { idempotencyKey: input.idempotencyKey });
    return { id: product.id };
  }

  async createPrice(keys: ProviderKeys, input: Parameters<PaymentProvider['createPrice']>[1]): Promise<{ id: string }> {
    const price = await this.client(keys).prices.create(
      {
        product: input.productId,
        currency: input.currency.toLowerCase(),
        unit_amount: toMinorUnits(input.amount, input.currency),
        recurring: { interval: input.interval },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { id: price.id };
  }

  async createPartnerAccount(
    keys: ProviderKeys,
    input: { partnerId: string; name: string; email: string | null; idempotencyKey: string },
  ): Promise<{ id: string }> {
    const account = await this.client(keys).accounts.create(
      {
        type: 'express',
        capabilities: { transfers: { requested: true } },
        business_profile: { name: input.name },
        metadata: { partner_id: input.partnerId },
        ...(input.email ? { email: input.email } : {}),
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { id: account.id };
  }

  async partnerOnboardingLink(
    keys: ProviderKeys,
    accountId: string,
    urls: { returnUrl: string; refreshUrl: string },
  ): Promise<{ url: string; expiresAt: Date }> {
    const link = await this.client(keys).accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      return_url: urls.returnUrl,
      refresh_url: urls.refreshUrl,
    });
    return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
  }

  async getPartnerAccount(
    keys: ProviderKeys,
    accountId: string,
  ): Promise<{ state: 'onboarding' | 'ready' | 'restricted' }> {
    const account = await this.client(keys).accounts.retrieve(accountId);
    if (account.capabilities?.transfers === 'active') return { state: 'ready' };
    return { state: account.details_submitted ? 'restricted' : 'onboarding' };
  }

  async transfer(
    keys: ProviderKeys,
    input: Parameters<PaymentProvider['transfer']>[1],
  ): Promise<{ id: string }> {
    try {
      const transfer = await this.client(keys).transfers.create(
        {
          amount: toMinorUnits(input.amount, input.currency),
          currency: input.currency.toLowerCase(),
          destination: input.destination,
          description: input.description,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: transfer.id };
    } catch (error) {
      // A request Stripe rejects for what it says (no balance, account not ready): retrying changes nothing.
      if (error instanceof Stripe.errors.StripeInvalidRequestError) throw new ProviderRefusedError(error.message);
      throw error;
    }
  }

  /** The price a subscription schedule moves to once the current period ends, if it has one. */
  private async scheduledPrice(stripe: Stripe, scheduleId: string | null, periodEnd: number): Promise<string | null> {
    if (!scheduleId) return null;
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    const next = schedule.phases.find((phase) => phase.start_date >= periodEnd);
    return idOf(next?.items[0]?.price);
  }

  /** Stripe's fee on a payment, from the balance transaction of its charge. */
  private async feeOf(stripe: Stripe, paymentIntentId: string, currency: string): Promise<Prisma.Decimal> {
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });
    const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
    const transaction = charge && typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;
    return fromMinorUnits(transaction?.fee ?? 0, currency);
  }
}
