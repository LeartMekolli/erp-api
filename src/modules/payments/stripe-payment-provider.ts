import Stripe from 'stripe';
import { Prisma } from '../../generated/prisma/client';
import { InvalidSignatureError, ProviderRefusedError } from './payment-provider';
import type { PaymentProvider, ProviderEvent, ProviderKeys, ProviderPayment } from './payment-provider';

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
  ): Promise<ProviderPayment & { status: 'open' | 'complete' | 'expired' }> {
    const stripe = this.client(keys);
    const session = await stripe.checkout.sessions.retrieve(id);
    const currency = session.currency ?? 'eur';
    const paid = session.payment_status === 'paid';
    const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    return {
      status: session.status === 'complete' ? 'complete' : session.status === 'expired' ? 'expired' : 'open',
      paid,
      amount: fromMinorUnits(session.amount_total ?? 0, currency),
      fee: paid && paymentIntent ? await this.feeOf(stripe, paymentIntent, currency) : new Prisma.Decimal(0),
      paymentId: paymentIntent ?? null,
    };
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

  async getInvoice(keys: ProviderKeys, id: string): Promise<ProviderPayment & { status: 'open' | 'paid' | 'void' }> {
    const stripe = this.client(keys);
    const invoice = await stripe.invoices.retrieve(id, { expand: ['payments'] });
    const paid = invoice.status === 'paid';
    const payment = invoice.payments?.data.find((candidate) => candidate.status === 'paid')?.payment;
    const paymentIntent = payment?.payment_intent;
    const paymentId = typeof paymentIntent === 'string' ? paymentIntent : (paymentIntent?.id ?? null);
    return {
      status: paid ? 'paid' : invoice.status === 'void' ? 'void' : 'open',
      paid,
      amount: fromMinorUnits(invoice.total, invoice.currency),
      fee: paid && paymentId ? await this.feeOf(stripe, paymentId, invoice.currency) : new Prisma.Decimal(0),
      paymentId,
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
