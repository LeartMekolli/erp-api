import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { PaymentEvent } from '../../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { buildJournal } from './ledger';
import type { JournalEntry } from './ledger';
import { LedgerService } from './ledger.service';
import { OrderStarter } from './order-starter';
import { PaymentAccountService } from './payment-account.service';
import { registerEventHandler } from './payment-events.service';
import { PAYMENT_PROVIDER } from './payment-provider';
import type { PaymentProvider } from './payment-provider';
import { billableTotals } from './payment-state';

const SYSTEM = { type: 'system' } as const;

/**
 * The checkout's webhooks (Payments spec, goal 10). Each reads the checkout from the provider instead
 * of trusting the event, and is safe to run twice: a journal posts once per provider fact, a row once
 * complete stays complete, and an order starts once.
 */
@Injectable()
export class CheckoutEvents implements OnModuleInit {
  private readonly logger = new Logger(CheckoutEvents.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: PaymentAccountService,
    private readonly ledger: LedgerService,
    private readonly starter: OrderStarter,
    private readonly notifications: NotificationsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  onModuleInit(): void {
    registerEventHandler('checkout.session.completed', (tenantId, event) => this.paid(tenantId, event));
    registerEventHandler('checkout.session.async_payment_succeeded', (tenantId, event) => this.paid(tenantId, event));
    registerEventHandler('checkout.session.expired', (tenantId, event) => this.expired(tenantId, event));
  }

  /**
   * A checkout of ours the provider says is paid: the row is complete, the order billed, paid and the
   * provider's fee journalled, and a waiting order starts. A cancelled order is journalled but never
   * starts; its refund is Refunds' to make.
   */
  async paid(tenantId: string, event: PaymentEvent): Promise<void> {
    const row = await this.checkoutOf(tenantId, event.objectId);
    if (!row) return;
    const keys = (await this.accounts.keysFor(tenantId)).keys;
    const checkout = await this.provider.getCheckout(keys, event.objectId);
    if (!checkout.paid) return;

    const outcome = await this.prisma.inTenant(tenantId, async (tx) => {
      // The order first (lock order), then its checkouts; startProduction locks it again, harmlessly.
      await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${row.orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: row.orderId } });
      await tx.orderPayment.update({ where: { id: row.id }, data: { status: 'complete' } });
      // Paid through an older link: the newer one must not be paid as well.
      const others = await tx.orderPayment.findMany({
        where: { orderId: order.id, status: 'open', id: { not: row.id } },
        select: { id: true, providerCheckoutId: true },
      });
      await tx.orderPayment.updateMany({ where: { id: { in: others.map((other) => other.id) } }, data: { status: 'expired' } });

      const live = await tx.orderLine.findMany({ where: { orderId: order.id, cancelledAt: null }, select: { total: true } });
      const split = billableTotals(order, live.map((line) => line.total));
      // The checkout's own amount is what was paid; its tax is the order's share when it matches.
      const tax = split.total.equals(checkout.amount)
        ? split.tax
        : checkout.amount.mul(order.taxPercent).div(order.taxPercent.add(100)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const common = {
        occurredAt: new Date(),
        currency: order.currency,
        orderId: order.id,
        customerId: order.customerId,
        providerObjectId: event.objectId,
      };
      const customerId = order.customerId;
      const billed: JournalEntry[] = [
        { account: 'customer_receivable', amount: checkout.amount, customerId },
        { account: 'sales', amount: checkout.amount.sub(tax).neg(), customerId },
        ...(tax.isZero() ? [] : [{ account: 'tax_payable' as const, amount: tax.neg(), customerId }]),
      ];
      await this.ledger.post(tx, { ...buildJournal('order_billed', billed), ...common, memo: `Order ${order.number}` });
      const received = await this.ledger.post(tx, {
        ...buildJournal('payment_received', [
          { account: 'stripe_balance', amount: checkout.amount },
          { account: 'customer_receivable', amount: checkout.amount.neg(), customerId },
        ]),
        ...common,
        memo: `Order ${order.number} paid by checkout`,
      });
      if (checkout.fee.gt(0)) {
        await this.ledger.post(tx, {
          ...buildJournal('provider_fee', [
            { account: 'provider_fees', amount: checkout.fee },
            { account: 'stripe_balance', amount: checkout.fee.neg() },
          ]),
          ...common,
          memo: `Fee on order ${order.number}`,
        });
      }

      return {
        order,
        newlyPaid: received.created,
        started: await this.starter.start(tx, tenantId, order.id, SYSTEM),
        expireAtProvider: others.flatMap((other) => (other.providerCheckoutId ? [other.providerCheckoutId] : [])),
      };
    });

    // After commit: a failure here is logged, the payment stays recorded.
    await this.after(tenantId, async () => {
      for (const id of outcome.expireAtProvider) await this.provider.expireCheckout(keys, id);
    });
    await this.starter.announce(tenantId, outcome.started);
    if (outcome.newlyPaid) {
      await this.after(tenantId, () =>
        this.notifications.raise(tenantId, 'payment.received', { type: 'order', id: outcome.order.id }, {
          number: String(outcome.order.number),
          amount: `${checkout.amount.toFixed(2)} ${outcome.order.currency}`,
        }),
      );
    }
  }

  /** A checkout of ours the provider says has expired; one already complete stays complete. */
  async expired(tenantId: string, event: PaymentEvent): Promise<void> {
    const row = await this.checkoutOf(tenantId, event.objectId);
    if (!row) return;
    const checkout = await this.provider.getCheckout((await this.accounts.keysFor(tenantId)).keys, event.objectId);
    if (checkout.status !== 'expired') return;
    await this.prisma.inTenant(tenantId, (tx) =>
      tx.orderPayment.updateMany({ where: { id: row.id, status: 'open' }, data: { status: 'expired' } }),
    );
  }

  /** Our row for the provider's checkout; another's checkout is not ours, and is ignored. */
  private checkoutOf(tenantId: string, providerCheckoutId: string) {
    return this.prisma.inTenant(tenantId, (tx) =>
      tx.orderPayment.findFirst({ where: { providerCheckoutId }, select: { id: true, orderId: true } }),
    );
  }

  private async after(tenantId: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.logger.error({ err: error, tenantId }, 'a step after a checkout event failed');
    }
  }
}
