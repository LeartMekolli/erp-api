import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { PaymentEvent, Refund } from '../../generated/prisma/client';
import { JobsService as QueueService } from '../../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { JobsService } from '../partners/jobs.service';
import { refundJournals } from './ledger';
import { LedgerService } from './ledger.service';
import { PaymentAccountService } from './payment-account.service';
import { registerEventHandler } from './payment-events.service';
import { PAYMENT_PROVIDER } from './payment-provider';
import type { PaymentProvider, ProviderKeys } from './payment-provider';
import type { RefundSuggestionResponse } from './payment-response';
import { paidAndRefunded } from './payment-state';
import { suggestRefund } from './refund-suggestion';

type Tx = Prisma.TransactionClient;
type Settled = 'succeeded' | 'failed';

export const PAID_AFTER_CANCEL = 'Paid after the order was cancelled';

/**
 * Money given back (Payments spec). A refund is written under the order's lock, and what is pending
 * counts against what is left, so refunds never pass what was paid. One through the provider is
 * asked for by a job after the commit and settled by it or by the provider's webhook; one outside
 * the provider succeeds at once. Each is journalled once, when it succeeds.
 */
@Injectable()
export class RefundsService implements OnModuleInit {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly accounts: PaymentAccountService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly orders: OrdersService,
    private readonly partnerJobs: JobsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  onModuleInit(): void {
    this.orders.registerPaymentHooks({
      paidLeft: (tx, orderId) => this.paidLeft(tx, orderId),
      refund: async (tx, input) => {
        const refundId = await this.create(tx, input);
        return () => this.afterCreate(input.tenantId, refundId);
      },
    });
    registerEventHandler('refund.updated', (tenantId, event) => this.updated(tenantId, event));
    registerEventHandler('charge.refund.updated', (tenantId, event) => this.updated(tenantId, event));
  }

  /** What was paid and is neither refunded nor being refunded. */
  async paidLeft(tx: Tx, orderId: string): Promise<Prisma.Decimal> {
    const journals = await tx.ledgerJournal.findMany({
      where: { orderId, kind: 'payment_received' },
      select: { kind: true, lines: { select: { account: true, amount: true } } },
    });
    const refunding = await tx.refund.aggregate({ _sum: { amount: true }, where: { orderId, status: { in: ['pending', 'succeeded'] } } });
    return paidAndRefunded(journals).paid.sub(refunding._sum.amount ?? 0);
  }

  /**
   * Writes a refund, under the order's lock the caller holds: through the provider when the order was
   * paid there, else outside it, and then succeeded at once. More than is left is a 409.
   */
  async create(tx: Tx, input: { orderId: string; amount: Prisma.Decimal; reason: string; userId: string | null }): Promise<string> {
    const left = await this.paidLeft(tx, input.orderId);
    if (input.amount.gt(left)) {
      throw new ConflictException(`Only ${left.toFixed(2)} is left to refund of what was paid`);
    }
    const throughProvider = await tx.ledgerLine.findFirst({
      where: { account: 'stripe_balance', amount: { gt: 0 }, journal: { orderId: input.orderId, kind: 'payment_received' } },
      select: { id: true },
    });
    const refund = await tx.refund.create({
      data: {
        orderId: input.orderId,
        amount: input.amount,
        reason: input.reason,
        kind: throughProvider ? 'provider' : 'outside',
        status: 'pending',
        createdByUserId: input.userId,
      },
    });
    if (refund.kind === 'outside') await this.succeed(tx, refund);
    return refund.id;
  }

  /** After the commit: asks the provider for a refund through it; tells the customer of one already made. */
  async afterCreate(tenantId: string, refundId: string): Promise<void> {
    const refund = await this.prisma.inTenant(tenantId, (tx) => tx.refund.findUniqueOrThrow({ where: { id: refundId } }));
    if (refund.status === 'pending') {
      await this.queue.enqueue('payments.refund', { tenantId, refundId });
    } else {
      await this.tell(tenantId, refund, refund.status as Settled);
    }
  }

  /**
   * The job: asks the provider for the refund, with the refund's id as the idempotency key, and
   * settles it when the provider has. One settled already is left as it is.
   */
  async process(tenantId: string, refundId: string): Promise<void> {
    const refund = await this.prisma.inTenant(tenantId, (tx) => tx.refund.findUnique({ where: { id: refundId } }));
    if (!refund || refund.status !== 'pending' || refund.kind !== 'provider') return;
    const keys = (await this.accounts.keysFor(tenantId)).keys;
    let status: 'pending' | Settled;
    if (refund.providerRefundId) {
      status = (await this.provider.getRefund(keys, refund.providerRefundId)).status;
    } else {
      const made = await this.provider.refund(keys, {
        paymentId: await this.paymentOf(tenantId, keys, refund.orderId),
        amount: refund.amount,
        idempotencyKey: refund.id,
      });
      await this.prisma.inTenant(tenantId, (tx) =>
        tx.refund.updateMany({ where: { id: refund.id, providerRefundId: null }, data: { providerRefundId: made.id } }),
      );
      status = made.status;
    }
    if (status !== 'pending') await this.settle(tenantId, refund.id, status);
  }

  /** The provider's word on a refund of ours; another's is ignored. */
  async updated(tenantId: string, event: PaymentEvent): Promise<void> {
    const refund = await this.prisma.inTenant(tenantId, (tx) =>
      tx.refund.findFirst({ where: { providerRefundId: event.objectId }, select: { id: true } }),
    );
    if (!refund) return;
    const { status } = await this.provider.getRefund((await this.accounts.keysFor(tenantId)).keys, event.objectId);
    if (status !== 'pending') await this.settle(tenantId, refund.id, status);
  }

  /** What to refund if these lines, or every line left, were cancelled now (Payments spec). */
  async suggestion(tenantId: string, orderId: string, positions: number[] | undefined): Promise<RefundSuggestionResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('Order not found');
      const lines = await tx.orderLine.findMany({
        where: { orderId },
        select: { position: true, total: true, cancelledAt: true, groupId: true, parts: { select: { groupId: true } } },
      });
      for (const [index, position] of (positions ?? []).entries()) {
        if (!lines.some((line) => line.position === position && !line.cancelledAt)) {
          throw new BadRequestException({ message: 'The order has no such live line', errors: [{ path: `lines.${index}`, message: `no live line ${position}` }] });
        }
      }
      const live = lines.filter((line) => !line.cancelledAt);
      const chosen = positions ? live.filter((line) => positions.includes(line.position)) : live;
      if (chosen.length === 0) throw new ConflictException('Nothing left to cancel');
      const groupIds = chosen.flatMap((line) => [line.groupId, ...line.parts.map((part) => part.groupId)]).flatMap((id) => (id ? [id] : []));
      const paidLeft = await this.paidLeft(tx, orderId);
      const { suggested, workDone } = suggestRefund({
        cancelledLinesTotal: chosen.reduce((sum, line) => sum.add(line.total), new Prisma.Decimal(0)),
        shippingIfWhole: chosen.length === live.length ? order.shippingPrice : new Prisma.Decimal(0),
        taxPercent: order.taxPercent,
        partnersOwed: await this.partnerJobs.owedNow(tx, groupIds),
        paidLeft,
      });
      return { suggested: suggested.toFixed(2), work_done: workDone.toFixed(2), paid_left: paidLeft.toFixed(2) };
    });
  }

  /** Settles a pending refund under its order's lock, journalling one that succeeded; then tells of it. */
  private async settle(tenantId: string, refundId: string, status: Settled): Promise<void> {
    const settled = await this.prisma.inTenant(tenantId, async (tx) => {
      const { orderId } = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, select: { orderId: true } });
      await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      if (refund.status !== 'pending') return null;
      if (status === 'succeeded') await this.succeed(tx, refund);
      else await tx.refund.update({ where: { id: refund.id }, data: { status: 'failed' } });
      return refund;
    });
    if (settled) await this.tell(tenantId, settled, status);
  }

  /** Journals the refund and marks it succeeded: tax gives back its share of what the order cost. */
  private async succeed(tx: Tx, refund: Refund): Promise<void> {
    const order = await tx.order.findUniqueOrThrow({ where: { id: refund.orderId } });
    const tax = order.total.isZero()
      ? new Prisma.Decimal(0)
      : refund.amount.mul(order.taxAmount).div(order.total).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const cash = refund.kind === 'provider' ? 'stripe_balance' : 'outside_stripe';
    for (const draft of refundJournals(order.customerId, refund.amount, tax, cash)) {
      await this.ledger.post(tx, {
        ...draft,
        occurredAt: new Date(),
        currency: order.currency,
        orderId: order.id,
        customerId: order.customerId,
        refundId: refund.id,
        userId: refund.createdByUserId ?? undefined,
        memo: `Refund on order ${order.number}: ${refund.reason}`,
      });
    }
    await tx.refund.update({ where: { id: refund.id }, data: { status: 'succeeded' } });
  }

  /** The payment at the provider to refund: the order's completed checkout's, or its paid invoice's. */
  private async paymentOf(tenantId: string, keys: ProviderKeys, orderId: string): Promise<string> {
    const { checkout, invoice } = await this.prisma.inTenant(tenantId, async (tx) => ({
      checkout: await tx.orderPayment.findFirst({ where: { orderId, status: 'complete' }, select: { providerCheckoutId: true } }),
      invoice: await tx.invoice.findFirst({ where: { orderId, status: 'paid' }, select: { providerInvoiceId: true } }),
    }));
    const paymentId = checkout?.providerCheckoutId
      ? (await this.provider.getCheckout(keys, checkout.providerCheckoutId)).paymentId
      : invoice?.providerInvoiceId
        ? (await this.provider.getInvoice(keys, invoice.providerInvoiceId)).paymentId
        : null;
    if (!paymentId) throw new Error(`Order ${orderId} has no payment at the provider to refund`);
    return paymentId;
  }

  /** After the commit: the customer hears of a refund made, staff who refund of one refused. A failure is logged. */
  private async tell(tenantId: string, refund: Refund, status: Settled): Promise<void> {
    try {
      const order = await this.prisma.inTenant(tenantId, (tx) =>
        tx.order.findUniqueOrThrow({ where: { id: refund.orderId }, select: { number: true, currency: true } }),
      );
      const variables = { number: String(order.number), amount: `${refund.amount.toFixed(2)} ${order.currency}` };
      await this.notifications.raise(tenantId, status === 'succeeded' ? 'refund.made' : 'refund.failed', { type: 'order', id: refund.orderId }, variables);
    } catch (error) {
      this.logger.error({ err: error, tenantId, refundId: refund.id }, 'telling of a refund failed');
    }
  }
}
