import type { Prisma } from '../../generated/prisma/client';

/** The keys of one workspace's provider account. Sealed at rest, never logged. */
export interface ProviderKeys {
  secretKey: string;
}

/** The facts of a webhook event; the payload itself is never kept. */
export interface ProviderEvent {
  id: string;
  type: string;
  objectId: string;
  connectedAccountId: string | null;
}

export interface ProviderPayment {
  paid: boolean;
  amount: Prisma.Decimal;
  fee: Prisma.Decimal;
  paymentId: string | null;
}

export type ProviderSubscriptionStatus = 'incomplete' | 'active' | 'past_due' | 'ended';

/** A subscription as the provider holds it now. */
export interface ProviderSubscription {
  status: ProviderSubscriptionStatus;
  priceId: string;
  providerCustomerId: string;
  metadata: Record<string, string>;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** The price it moves to at the end of the period, when a change is scheduled. */
  scheduledPriceId: string | null;
  /** The price of an upgrade waiting for its invoice to be paid. */
  pendingPriceId: string | null;
}

/** Why a subscription's invoice was made: its first, a renewal, or a change of price. */
export type InvoiceReason = 'create' | 'cycle' | 'update' | 'other';

/** DI token: the fake for tests and local work, Stripe otherwise (`PAYMENT_PROVIDER`). */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** The signature does not match the body and secret. */
export class InvalidSignatureError extends Error {
  constructor(message = 'Invalid signature') {
    super(message);
    this.name = 'InvalidSignatureError';
  }
}

/** The provider has no such object: it was made by someone else, or never existed. */
export class ProviderNotFoundError extends Error {
  constructor(message = 'No such object at the payment provider') {
    super(message);
    this.name = 'ProviderNotFoundError';
  }
}

/** The provider declined, and trying again will not change that (a transfer without balance). */
export class ProviderRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRefusedError';
  }
}

/**
 * Where money moves (Payments spec). Amounts cross this interface as `Decimal`; only an
 * implementation converts them to its own units. Callers never call it inside a database
 * transaction, and pass an idempotency key derived from their own row id.
 */
export interface PaymentProvider {
  readonly name: 'fake' | 'stripe';
  /** Checks the signature on the raw body. Throws `InvalidSignatureError`. */
  verifyEvent(rawBody: Buffer, signatureHeader: string, signingSecret: string): ProviderEvent;
  createCheckout(
    keys: ProviderKeys,
    input: {
      amount: Prisma.Decimal;
      currency: string;
      description: string;
      expiresAt: Date;
      successUrl: string;
      cancelUrl: string;
      metadata: Record<string, string>;
      idempotencyKey: string;
    },
  ): Promise<{ id: string; url: string }>;
  /**
   * `subscriptionId` is set on a subscription's checkout once it is complete; `metadata` is what it
   * was made with. Unknown: `ProviderNotFoundError`.
   */
  getCheckout(
    keys: ProviderKeys,
    id: string,
  ): Promise<
    ProviderPayment & { status: 'open' | 'complete' | 'expired'; subscriptionId: string | null; metadata: Record<string, string> }
  >;
  /** Already expired or complete: no error. */
  expireCheckout(keys: ProviderKeys, id: string): Promise<void>;
  ensureCustomer(
    keys: ProviderKeys,
    /** `email` is null when the customer has no one to send its invoices to. */
    input: { customerId: string; name: string; email: string | null; idempotencyKey: string },
  ): Promise<{ id: string }>;
  createInvoice(
    keys: ProviderKeys,
    input: {
      providerCustomerId: string;
      currency: string;
      lines: { description: string; amount: Prisma.Decimal }[];
      tax: Prisma.Decimal;
      daysUntilDue: number;
      metadata: Record<string, string>;
      idempotencyKey: string;
    },
  ): Promise<{ id: string; url: string; dueOn: string }>;
  /**
   * A subscription's invoice names it, why it was made and the period it pays for; an order's has
   * none of these. `amount` is the invoice's total, below zero when it gives money back;
   * `amountPaid` is what a payment took, apart from the customer's balance at the provider (an
   * order's: all of it). Unknown: `ProviderNotFoundError`.
   */
  getInvoice(
    keys: ProviderKeys,
    id: string,
  ): Promise<
    ProviderPayment & {
      amountPaid: Prisma.Decimal;
      status: 'open' | 'paid' | 'void';
      subscriptionId: string | null;
      reason: InvoiceReason | null;
      periodStart: Date | null;
      periodEnd: Date | null;
    }
  >;
  markInvoicePaidOutside(keys: ProviderKeys, id: string): Promise<void>;
  refund(
    keys: ProviderKeys,
    input: { paymentId: string; amount: Prisma.Decimal; idempotencyKey: string },
  ): Promise<{ id: string; status: 'pending' | 'succeeded' | 'failed' }>;
  getRefund(keys: ProviderKeys, id: string): Promise<{ status: 'pending' | 'succeeded' | 'failed' }>;
  createPartnerAccount(
    keys: ProviderKeys,
    input: { partnerId: string; name: string; email: string | null; idempotencyKey: string },
  ): Promise<{ id: string }>;
  partnerOnboardingLink(
    keys: ProviderKeys,
    accountId: string,
    urls: { returnUrl: string; refreshUrl: string },
  ): Promise<{ url: string; expiresAt: Date }>;
  getPartnerAccount(keys: ProviderKeys, accountId: string): Promise<{ state: 'onboarding' | 'ready' | 'restricted' }>;
  /** What a plan is sold as at the provider; one per idempotency key. */
  ensureProduct(keys: ProviderKeys, input: { name: string; idempotencyKey: string }): Promise<{ id: string }>;
  /** A recurring price on a product. Prices never change; a new amount is a new price. */
  createPrice(
    keys: ProviderKeys,
    input: { productId: string; amount: Prisma.Decimal; currency: string; interval: 'month' | 'year'; idempotencyKey: string },
  ): Promise<{ id: string }>;
  /** A checkout that subscribes the customer to a recurring price. */
  createSubscriptionCheckout(
    keys: ProviderKeys,
    input: {
      providerCustomerId: string;
      priceId: string;
      successUrl: string;
      cancelUrl: string;
      metadata: Record<string, string>;
      idempotencyKey: string;
    },
  ): Promise<{ id: string; url: string }>;
  getSubscription(keys: ProviderKeys, id: string): Promise<ProviderSubscription>;
  /**
   * Moves to a dearer price at once, prorated and invoiced now; the price changes only when that
   * invoice is paid, and stays as it was when it isn't.
   */
  upgradeSubscription(keys: ProviderKeys, id: string, input: { priceId: string; idempotencyKey: string }): Promise<void>;
  /**
   * Ends a pending upgrade by voiding its open invoice, so paying that invoice later changes nothing.
   * No upgrade pending: no error.
   */
  withdrawUpgrade(keys: ProviderKeys, id: string): Promise<void>;
  /** The price from the next period on; null removes a scheduled change. */
  scheduleSubscriptionPrice(keys: ProviderKeys, id: string, input: { priceId: string | null; idempotencyKey: string }): Promise<void>;
  setCancelAtPeriodEnd(keys: ProviderKeys, id: string, cancel: boolean): Promise<void>;
  /** Where the customer changes its card, plan or cancels, at the provider. */
  billingPortalLink(keys: ProviderKeys, input: { providerCustomerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Throws `ProviderRefusedError` with a message when the provider declines. */
  transfer(
    keys: ProviderKeys,
    input: { destination: string; amount: Prisma.Decimal; currency: string; description: string; idempotencyKey: string },
  ): Promise<{ id: string }>;
}
