import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { PaymentEvent } from '../../../generated/prisma/client';
import { lockCustomer } from '../../customers/customers.service';
import { AllowancesService } from '../credits/allowances.service';
import { creditAppliedJournal, feeJournal, planBilledJournal, planCreditedJournal, receivedJournal } from '../ledger';
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
    private readonly allowances: AllowancesService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  onModuleInit(): void {
    registerEventHandler('checkout.session.completed', (tenantId, event) => this.checkoutCompleted(tenantId, event), OWNER);
    for (const type of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']) {
      registerEventHandler(type, (tenantId, event) => this.subscriptions.sync(tenantId, event.objectId), OWNER);
    }
    registerEventHandler('invoice.paid', (tenantId, event) => this.invoicePaid(tenantId, event), OWNER);
    registerEventHandler('invoice.payment_succeeded', (tenantId, event) => this.invoicePaid(tenantId, event), OWNER);
    registerEventHandler('invoice.payment_failed', (tenantId, event) => this.invoiceFailed(tenantId, event), OWNER);
  }

  /** A subscription invoice the provider couldn't charge: the customer is told once. An order's is skipped. */
  async invoiceFailed(tenantId: string, event: PaymentEvent): Promise<void> {
    const invoice = await this.subscriptionInvoice(tenantId, event.objectId);
    if (!invoice?.subscriptionId || invoice.paid) return;
    await this.subscriptions.paymentFailed(tenantId, invoice.subscriptionId, { id: event.objectId, reason: invoice.reason });
  }

  /** The invoice, unless it is an order's or the provider doesn't know it. */
  private async subscriptionInvoice(tenantId: string, providerInvoiceId: string) {
    const forOrder = await this.prisma.inTenant(tenantId, (tx) =>
      tx.invoice.findFirst({ where: { providerInvoiceId }, select: { id: true } }),
    );
    if (forOrder) return null;
    try {
      return await this.provider.getInvoice((await this.accounts.keysFor(tenantId)).keys, providerInvoiceId);
    } catch (error) {
      // Made by someone else on the same account: not ours, and asking again won't change that.
      if (error instanceof ProviderNotFoundError) return null;
      throw error;
    }
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
   * A paid invoice of one of our subscriptions: the subscription is synced, the period it pays for is
   * recorded as paid and brings its allowance, and the invoice is journalled by what was paid, each
   * journal once. An order's invoice is skipped.
   */
  async invoicePaid(tenantId: string, event: PaymentEvent): Promise<void> {
    const invoice = await this.subscriptionInvoice(tenantId, event.objectId);
    if (!invoice?.subscriptionId || !invoice.paid) return;

    await this.subscriptions.sync(tenantId, invoice.subscriptionId);
    const subscription = await this.subscriptions.subscriptionOf(tenantId, invoice.subscriptionId);
    if (!subscription) return;

    await this.prisma.inTenant(tenantId, async (tx) => {
      await lockCustomer(tx, subscription.customerId);
      // The provider makes a renewal active before it charges it: the month is owed only from here.
      if (invoice.periodStart && invoice.periodEnd && invoice.periodEnd > invoice.periodStart) {
        await tx.subscriptionPaidPeriod.createMany({
          data: [
            {
              customerId: subscription.customerId,
              providerSubscriptionId: subscription.providerSubscriptionId,
              providerInvoiceId: event.objectId,
              periodStart: invoice.periodStart,
              periodEnd: invoice.periodEnd,
            },
          ],
          skipDuplicates: true,
        });
      }
      await this.allowances.grantDue(tx, subscription.customerId, invoice.periodStart ?? new Date());
      // Nothing to journal for a period that cost nothing.
      if (invoice.amount.isZero()) return;
      const price = await tx.planPrice.findUniqueOrThrow({ where: { id: subscription.planPriceId }, include: { plan: { select: { name: true } } } });
      const common = {
        occurredAt: new Date(),
        currency: price.currency,
        customerId: subscription.customerId,
        providerObjectId: event.objectId,
      };
      // Below zero (a cheaper plan mid-period): the provider keeps the difference as the customer's
      // balance, and no money moves.
      if (invoice.amount.lt(0)) {
        await this.ledger.post(tx, {
          ...planCreditedJournal(subscription.customerId, invoice.amount.neg()),
          ...common,
          memo: `Plan ${price.plan.name} credited`,
        });
        return;
      }
      await this.ledger.post(tx, {
        ...planBilledJournal(subscription.customerId, invoice.amount),
        ...common,
        memo: `Plan ${price.plan.name} billed`,
      });
      // What a payment took arrived as cash; the rest came out of the customer's balance.
      if (invoice.amountPaid.gt(0)) {
        await this.ledger.post(tx, {
          ...receivedJournal(subscription.customerId, invoice.amountPaid, 'stripe_balance'),
          ...common,
          memo: `Plan ${price.plan.name} paid`,
        });
      }
      const fromCredit = invoice.amount.sub(invoice.amountPaid);
      if (fromCredit.gt(0)) {
        await this.ledger.post(tx, {
          ...creditAppliedJournal(subscription.customerId, fromCredit),
          ...common,
          memo: `Plan ${price.plan.name} paid from credit`,
        });
      }
      if (invoice.fee.gt(0)) {
        await this.ledger.post(tx, { ...feeJournal(invoice.fee), ...common, memo: `Fee on plan ${price.plan.name}` });
      }
    });
  }
}
