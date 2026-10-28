import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { PaymentEvent } from '../../../generated/prisma/client';
import { lockCustomer } from '../../customers/customers.service';
import { feeJournal, planBilledJournal, receivedJournal } from '../ledger';
import { LedgerService } from '../ledger.service';
import { PaymentAccountService } from '../payment-account.service';
import { registerEventHandler } from '../payment-events.service';
import { PAYMENT_PROVIDER, ProviderNotFoundError } from '../payment-provider';
import type { PaymentProvider } from '../payment-provider';
import { SubscriptionsService } from './subscriptions.service';

const OWNER = 'subscriptions';

/**
 * The webhooks of subscriptions (Payments 2 spec, D47). They share event types with orders' checkouts
 * and invoices, so each first skips what belongs to an order, then reads the object from the provider.
 * Every one is safe to run twice: `sync` writes what the provider says now, and a journal posts once
 * per invoice.
 */
@Injectable()
export class SubscriptionEvents implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: PaymentAccountService,
    private readonly ledger: LedgerService,
    private readonly subscriptions: SubscriptionsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  onModuleInit(): void {
    registerEventHandler('checkout.session.completed', (tenantId, event) => this.checkoutCompleted(tenantId, event), OWNER);
    for (const type of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']) {
      registerEventHandler(type, (tenantId, event) => this.subscriptions.sync(tenantId, event.objectId), OWNER);
    }
    registerEventHandler('invoice.paid', (tenantId, event) => this.invoicePaid(tenantId, event), OWNER);
    registerEventHandler('invoice.payment_succeeded', (tenantId, event) => this.invoicePaid(tenantId, event), OWNER);
  }

  /** A subscription's checkout: the subscription it made is synced. An order's checkout is skipped. */
  async checkoutCompleted(tenantId: string, event: PaymentEvent): Promise<void> {
    const forOrder = await this.prisma.inTenant(tenantId, (tx) =>
      tx.orderPayment.findFirst({ where: { providerCheckoutId: event.objectId }, select: { id: true } }),
    );
    if (forOrder) return;
    let subscriptionId: string | null;
    try {
      subscriptionId = (await this.provider.getCheckout((await this.accounts.keysFor(tenantId)).keys, event.objectId)).subscriptionId;
    } catch (error) {
      // Made by someone else on the same account: not ours, and asking again won't change that.
      if (error instanceof ProviderNotFoundError) return;
      throw error;
    }
    if (subscriptionId) await this.subscriptions.sync(tenantId, subscriptionId);
  }

  /**
   * A paid invoice of one of our subscriptions: the subscription is synced, then the period is billed,
   * paid and the provider's fee journalled, each once. An order's invoice is skipped.
   */
  async invoicePaid(tenantId: string, event: PaymentEvent): Promise<void> {
    const forOrder = await this.prisma.inTenant(tenantId, (tx) =>
      tx.invoice.findFirst({ where: { providerInvoiceId: event.objectId }, select: { id: true } }),
    );
    if (forOrder) return;
    let invoice: Awaited<ReturnType<PaymentProvider['getInvoice']>>;
    try {
      invoice = await this.provider.getInvoice((await this.accounts.keysFor(tenantId)).keys, event.objectId);
    } catch (error) {
      if (error instanceof ProviderNotFoundError) return;
      throw error;
    }
    if (!invoice.subscriptionId || !invoice.paid) return;

    await this.subscriptions.sync(tenantId, invoice.subscriptionId);
    const subscription = await this.subscriptions.subscriptionOf(tenantId, invoice.subscriptionId);
    // Not ours, or nothing to journal (a period that cost nothing).
    if (!subscription || invoice.amount.isZero()) return;

    await this.prisma.inTenant(tenantId, async (tx) => {
      await lockCustomer(tx, subscription.customerId);
      const price = await tx.planPrice.findUniqueOrThrow({ where: { id: subscription.planPriceId }, include: { plan: { select: { name: true } } } });
      const common = {
        occurredAt: new Date(),
        currency: price.currency,
        customerId: subscription.customerId,
        providerObjectId: event.objectId,
      };
      await this.ledger.post(tx, {
        ...planBilledJournal(subscription.customerId, invoice.amount),
        ...common,
        memo: `Plan ${price.plan.name} billed`,
      });
      await this.ledger.post(tx, {
        ...receivedJournal(subscription.customerId, invoice.amount, 'stripe_balance'),
        ...common,
        memo: `Plan ${price.plan.name} paid`,
      });
      if (invoice.fee.gt(0)) {
        await this.ledger.post(tx, { ...feeJournal(invoice.fee), ...common, memo: `Fee on plan ${price.plan.name}` });
      }
    });
  }
}
