import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { customerOrderLink } from '../notifications/web-links';
import { OrdersService } from '../orders/orders.service';
import { parseSetting } from '../settings/setting-keys';
import { SettingsService } from '../settings/settings.service';
import { PaymentAccountService } from './payment-account.service';
import { PAYMENT_PROVIDER } from './payment-provider';
import type { PaymentProvider } from './payment-provider';
import { billableTotals, paidAndRefunded } from './payment-state';

const HOUR_MS = 3_600_000;
/** The provider's limits on how long a checkout stays open. */
const MIN_OPEN_MS = 30 * 60_000;
const MAX_OPEN_MS = 24 * HOUR_MS;

/**
 * Checkouts for pay-first orders (Payments spec): one open at a time, for what the order's live lines
 * cost now. Our row is written and committed first; the provider is called outside any transaction,
 * with the row's id as its idempotency key.
 */
@Injectable()
export class CheckoutService implements OnModuleInit {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly accounts: PaymentAccountService,
    private readonly notifications: NotificationsService,
    private readonly orders: OrdersService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  onModuleInit(): void {
    this.orders.registerPaymentHooks({
      placed: async (tenantId, orderId) => {
        const { url, number, total, payBy } = await this.open(tenantId, orderId);
        await this.notifications.raise(tenantId, 'payment.requested', { type: 'order', id: orderId }, {
          number,
          total,
          pay_url: url,
          pay_by: payBy,
        });
      },
      cancelled: (tenantId, orderId) => this.expireOpen(tenantId, orderId),
    });
  }

  /**
   * A new checkout for the waiting order, replacing any open one. Only an order that waits for
   * payment, is not cancelled and has nothing paid gets one (else 409). With `customerId`, another
   * customer's order is not found.
   */
  async open(
    tenantId: string,
    orderId: string,
    customerId?: string,
  ): Promise<{ url: string; number: string; total: string; payBy: string }> {
    const keys = await this.accounts.keysFor(tenantId);
    const prepared = await this.prisma.inTenant(tenantId, async (tx) => {
      // The order row first (lock order): two requests for a link at once write one open row each in turn.
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = rows.length > 0 ? await tx.order.findUniqueOrThrow({ where: { id: orderId } }) : null;
      if (!order || (customerId !== undefined && order.customerId !== customerId)) throw new NotFoundException('Order not found');
      const journals = await tx.ledgerJournal.findMany({
        where: { orderId, kind: { in: ['payment_received', 'refund'] } },
        select: { kind: true, lines: { select: { account: true, amount: true } } },
      });
      if (order.cancelledAt || order.productionStartedAt || !order.payBy || paidAndRefunded(journals).paid.gt(0)) {
        throw new ConflictException('Only an order waiting for payment can be paid');
      }
      const replaced = await this.expireRows(tx, orderId);
      const live = await tx.orderLine.findMany({ where: { orderId, cancelledAt: null }, select: { total: true } });
      const { total } = billableTotals(order, live.map((line) => line.total));
      const now = Date.now();
      const expiresAt = new Date(Math.max(now + MIN_OPEN_MS, Math.min(order.payBy.getTime(), now + MAX_OPEN_MS)));
      const row = await tx.orderPayment.create({
        data: { orderId, amount: total, currency: order.currency, status: 'open', expiresAt },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, customerSiteOrigin: true } });
      const collection = parseSetting('payments.collection', (await this.settings.list(tx))['payments.collection'] ?? {});
      return { order, row, replaced, tenant, collection };
    });
    const { order, row, tenant, collection } = prepared;

    await this.expireAtProvider(keys.keys, prepared.replaced);
    const target = { webTemplate: this.config.get('WEB_URL_TEMPLATE'), slug: tenant.slug, customerSiteOrigin: tenant.customerSiteOrigin };
    let checkout: { id: string; url: string };
    try {
      checkout = await this.provider.createCheckout(keys.keys, {
        amount: row.amount,
        currency: row.currency,
        description: `Order ${order.number}`,
        expiresAt: row.expiresAt,
        successUrl: collection.checkoutSuccessUrl ?? customerOrderLink(target, orderId, '?payment=success'),
        cancelUrl: collection.checkoutCancelUrl ?? customerOrderLink(target, orderId, '?payment=cancelled'),
        metadata: { tenant_id: tenantId, order_id: orderId, order_payment_id: row.id },
        idempotencyKey: row.id,
      });
    } catch (error) {
      // Never payable: the next request opens a new one.
      await this.prisma.inTenant(tenantId, (tx) =>
        tx.orderPayment.updateMany({ where: { id: row.id, status: 'open' }, data: { status: 'expired' } }),
      );
      this.logger.error({ err: error, orderId }, 'the payment provider refused a checkout');
      throw new ServiceUnavailableException('The payment provider is not answering; try again shortly');
    }

    const kept = await this.prisma.inTenant(tenantId, (tx) =>
      tx.orderPayment.updateMany({
        where: { id: row.id, status: 'open' },
        data: { providerCheckoutId: checkout.id, url: checkout.url },
      }),
    );
    if (kept.count === 0) {
      // Replaced or cancelled while the provider was answering: this one must not be payable either.
      await this.expireAtProvider(keys.keys, [checkout.id]);
      throw new ConflictException('The order changed while its link was made; ask for a new one');
    }
    return {
      url: checkout.url,
      number: String(order.number),
      total: `${row.amount.toFixed(2)} ${row.currency}`,
      payBy: order.payBy!.toISOString(),
    };
  }

  /** The order's open checkout, if any, can no longer be paid: after a line or the order is cancelled. */
  async expireOpen(tenantId: string, orderId: string): Promise<void> {
    const expired = await this.prisma.inTenant(tenantId, (tx) => this.expireRows(tx, orderId));
    if (expired.length === 0) return;
    await this.expireAtProvider((await this.accounts.keysFor(tenantId)).keys, expired);
  }

  /** Marks the order's open rows expired; answers the provider ids to expire there. */
  private async expireRows(tx: Prisma.TransactionClient, orderId: string): Promise<string[]> {
    const open = await tx.orderPayment.findMany({ where: { orderId, status: 'open' }, select: { id: true, providerCheckoutId: true } });
    if (open.length === 0) return [];
    await tx.orderPayment.updateMany({ where: { id: { in: open.map((row) => row.id) } }, data: { status: 'expired' } });
    return open.flatMap((row) => (row.providerCheckoutId ? [row.providerCheckoutId] : []));
  }

  /** Expires checkouts at the provider; one already expired or complete is no error there. */
  private async expireAtProvider(keys: { secretKey: string }, checkoutIds: string[]): Promise<void> {
    for (const id of checkoutIds) {
      await this.provider.expireCheckout(keys, id);
    }
  }
}
