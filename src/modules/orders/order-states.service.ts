import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type { Order } from '../../generated/prisma/client';
import { INVOICE_STATUSES, paidAndRefunded, paymentState } from '../payments/payment-state';
import type { PaymentState, PaymentTerms } from '../payments/payment-state';
import { localDate } from './dates';
import { lineState, orderState } from './order-state';
import type { OrderState } from './order-state';

type Tx = Prisma.TransactionClient;

export type StoredStates = { state: OrderState; paymentState: PaymentState };

/**
 * The only writer of an order's stored `state` and `payment_state` (Orders list spec, goals 1–7). Both are
 * decided by `orderState()` and `paymentState()` from the order's facts, never by what is stored.
 */
@Injectable()
export class OrderStatesService {
  /** Both states of each order, from its facts alone: the stored columns are ignored. */
  async derive(tx: Tx, orders: Order[], today: string): Promise<Map<string, StoredStates>> {
    if (orders.length === 0) return new Map();
    const ids = orders.map((order) => order.id);
    const lines = await tx.orderLine.findMany({ where: { orderId: { in: ids } }, select: { orderId: true, groupId: true, cancelledAt: true } });
    const groupIds = lines.flatMap((line) => (line.groupId ? [line.groupId] : []));
    const pieces = await tx.workOrder.findMany({ where: { groupId: { in: groupIds } }, select: { groupId: true, status: true } });
    // What was paid and refunded comes from the ledger (Payments spec).
    const journals = await tx.ledgerJournal.findMany({
      where: { orderId: { in: ids }, kind: { in: ['payment_received', 'refund'] } },
      select: { orderId: true, kind: true, lines: { select: { account: true, amount: true } } },
    });
    // An invoice counts once the provider has made it; one still being made does not.
    const invoices = await tx.invoice.findMany({
      where: { orderId: { in: ids }, status: { in: [...INVOICE_STATUSES] }, url: { not: null } },
      select: { orderId: true, dueOn: true, status: true },
    });

    return new Map(
      orders.map((order) => {
        const lineStates = lines
          .filter((line) => line.orderId === order.id)
          .map((line) => lineState(pieces.filter((piece) => piece.groupId === line.groupId), line.cancelledAt));
        const { paid, refunded } = paidAndRefunded(journals.filter((journal) => journal.orderId === order.id));
        const invoice = invoices.find((row) => row.orderId === order.id);
        return [
          order.id,
          {
            state: orderState(lineStates, order.shippedAt, order.deliveredAt, order.productionStartedAt),
            paymentState: paymentState({
              terms: order.paymentTerms as PaymentTerms,
              cancelled: order.cancelledAt !== null,
              started: order.productionStartedAt !== null,
              paid,
              refunded,
              invoice: invoice ? { status: invoice.status as (typeof INVOICE_STATUSES)[number], dueOn: invoice.dueOn.toISOString().slice(0, 10) } : null,
              today,
            }),
          },
        ];
      }),
    );
  }

  /**
   * Locks the orders (in id order; harmless when the caller holds the lock already), derives both states
   * and writes those that changed, in the caller's transaction.
   */
  async refresh(tx: Tx, orderIds: string[]): Promise<void> {
    const ids = [...new Set(orderIds)];
    if (ids.length === 0) return;
    await tx.$queryRaw`SELECT id FROM "order" WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
    const orders = await tx.order.findMany({ where: { id: { in: ids } } });
    if (orders.length === 0) return;
    const derived = await this.derive(tx, orders, await this.today(tx, orders[0].tenantId));
    for (const order of orders) {
      const next = derived.get(order.id)!;
      if (order.state === next.state && order.paymentState === next.paymentState) continue;
      await tx.order.update({ where: { id: order.id }, data: { state: next.state, paymentState: next.paymentState } });
    }
  }

  /** The workspace's date today, in its own time zone. */
  async today(tx: Tx, tenantId: string): Promise<string> {
    const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
    return localDate(new Date(), timezone);
  }
}
