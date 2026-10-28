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

/** DI token: the fake for tests and local work, Stripe otherwise (`PAYMENT_PROVIDER`). */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** The signature does not match the body and secret. */
export class InvalidSignatureError extends Error {
  constructor(message = 'Invalid signature') {
    super(message);
    this.name = 'InvalidSignatureError';
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
  getCheckout(keys: ProviderKeys, id: string): Promise<ProviderPayment & { status: 'open' | 'complete' | 'expired' }>;
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
  getInvoice(keys: ProviderKeys, id: string): Promise<ProviderPayment & { status: 'open' | 'paid' | 'void' }>;
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
  /** Throws `ProviderRefusedError` with a message when the provider declines. */
  transfer(
    keys: ProviderKeys,
    input: { destination: string; amount: Prisma.Decimal; currency: string; description: string; idempotencyKey: string },
  ): Promise<{ id: string }>;
}
