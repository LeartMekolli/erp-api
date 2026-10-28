import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import { localDate } from '../orders/dates';
import type { OrderResponse } from '../orders/order-response';
import { OrdersService } from '../orders/orders.service';
import { CheckoutService } from './checkout.service';
import { billedJournal, receivedJournal } from './ledger';
import { LedgerService } from './ledger.service';
import { OrderStarter } from './order-starter';
import type { Started } from './order-starter';
import { PaymentAccountService } from './payment-account.service';
import { PAYMENT_PROVIDER } from './payment-provider';
import type { PaymentProvider } from './payment-provider';
import type { PaidByHand } from './payment-response';
import { billableTotals, paidAndRefunded } from './payment-state';

/**
 * Payments made outside the provider, such as a bank transfer, recorded by staff (Payments spec).
 * A waiting order is billed, paid and started; an open invoice is paid, and marked paid outside at
 * the provider. The money is on `outside_stripe`, with no fee.
 */
@Injectable()
export class PaidByHandService {
  private readonly logger = new Logger(PaidByHandService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly orders: OrdersService,
    private readonly checkout: CheckoutService,
    private readonly starter: OrderStarter,
    private readonly accounts: PaymentAccountService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /** Anything not waiting for payment and without an open invoice has nothing to pay (409). */
  async record(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, orderId: string, input: PaidByHand): Promise<OrderResponse> {
    const outcome = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundException('Order not found');
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { timezone: true } });
      if (input.received_on > localDate(new Date(), tenant.timezone)) {
        throw new BadRequestException({
          message: 'A payment can only be recorded once it has arrived',
          errors: [{ path: 'received_on', message: 'is in the future' }],
        });
      }
      const journals = await tx.ledgerJournal.findMany({
        where: { orderId, kind: { in: ['payment_received', 'refund'] } },
        select: { kind: true, lines: { select: { account: true, amount: true } } },
      });
      if (order.cancelledAt || paidAndRefunded(journals).paid.gt(0)) {
        throw new ConflictException('Nothing to pay: the order is paid or cancelled');
      }

      const receivedAt = new Date(`${input.received_on}T00:00:00Z`);
      const common = { currency: order.currency, orderId, customerId: order.customerId, userId: auth.userId };
      const memo = `Order ${order.number} paid by hand: ${input.reference}`;
      let amount: Prisma.Decimal;
      let started: Started | null = null;
      let expired: string[] = [];
      let invoiceAtProvider: string | null = null;
      if (!order.productionStartedAt && order.payBy) {
        // Waiting for payment: billed for its live lines now, paid, and started.
        const live = await tx.orderLine.findMany({ where: { orderId, cancelledAt: null }, select: { total: true } });
        const totals = billableTotals(order, live.map((line) => line.total));
        amount = totals.total;
        await this.ledger.post(tx, { ...billedJournal(order.customerId, amount, totals.tax), ...common, occurredAt: new Date(), memo: `Order ${order.number}` });
        await this.ledger.post(tx, { ...receivedJournal(order.customerId, amount, 'outside_stripe'), ...common, occurredAt: receivedAt, memo });
        expired = await this.checkout.expireRows(tx, orderId);
        started = await this.starter.start(tx, auth.tenantId, orderId, { type: 'user', id: auth.userId });
      } else {
        const invoice = await tx.invoice.findFirst({ where: { orderId, status: 'open' } });
        if (!invoice) throw new ConflictException('Nothing to pay: the order waits for no payment and has no open invoice');
        amount = invoice.total;
        // The invoice's own provider id: the provider's paid webhook that follows posts nothing more.
        await this.ledger.post(tx, {
          ...receivedJournal(order.customerId, amount, 'outside_stripe'),
          ...common,
          occurredAt: receivedAt,
          providerObjectId: invoice.providerInvoiceId ?? undefined,
          memo,
        });
        await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'paid', paidAt: new Date() } });
        invoiceAtProvider = invoice.providerInvoiceId;
      }
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'order.paid_by_hand',
        subject: { type: 'order', id: orderId },
        after: { reference: input.reference, received_on: input.received_on, amount: amount.toFixed(2) },
      });
      return { order, amount, started, expired, invoiceAtProvider };
    });

    // The payment has committed: a failure from here on is logged, never answered.
    await this.after(orderId, () => this.checkout.expireAt(auth.tenantId, outcome.expired));
    const { invoiceAtProvider } = outcome;
    if (invoiceAtProvider) {
      await this.after(orderId, async () =>
        this.provider.markInvoicePaidOutside((await this.accounts.keysFor(auth.tenantId)).keys, invoiceAtProvider),
      );
    }
    await this.starter.announce(auth.tenantId, outcome.started);
    await this.after(orderId, () =>
      this.notifications.raise(auth.tenantId, 'payment.received', { type: 'order', id: orderId }, {
        number: String(outcome.order.number),
        amount: `${outcome.amount.toFixed(2)} ${outcome.order.currency}`,
      }),
    );
    return this.orders.get(auth.tenantId, orderId);
  }

  private async after(orderId: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.logger.error({ err: error, orderId }, 'a step after a payment by hand failed');
    }
  }
}
