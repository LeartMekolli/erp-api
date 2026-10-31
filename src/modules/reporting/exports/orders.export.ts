import { Injectable, OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { PrismaService } from '../../../database/prisma.service';
import type { TenantPermission } from '../../identity/permissions';
import { localDate, startOfLocalDay } from '../../orders/dates';
import { lineState, orderState } from '../../orders/order-state';
import { addDays } from '../week-metrics';
import type { CsvCell, CsvColumn } from './csv';
import type { CsvBuilder, ExportContext, ordersParamsSchema } from './export-kinds';
import { ExportsService } from './exports.service';

type Params = z.infer<typeof ordersParamsSchema>;

/** Jobs that hold a line for a partner, as the order screens show them. */
const HOLDING = ['offered', 'accepted'];
const dayOf = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Orders placed in a range (Reporting 2 spec, goal 11), one row per line with the order's fields
 * repeated, by order number then line. The state is the one the order screens show, filtered after it is
 * worked out. Money columns need `payment.read`, the partner holding a line's job `partner.read`.
 */
@Injectable()
export class OrdersExport implements CsvBuilder<Params>, OnModuleInit {
  readonly kind = 'orders';
  readonly format = 'csv';

  constructor(
    private readonly prisma: PrismaService,
    private readonly exports: ExportsService,
  ) {}

  onModuleInit(): void {
    this.exports.register(this as CsvBuilder);
  }

  columns(may: ReadonlySet<TenantPermission>): CsvColumn[] {
    return [
      { key: 'order_number', label: 'Order' },
      { key: 'placed_on', label: 'Placed on' },
      { key: 'customer', label: 'Customer' },
      { key: 'state', label: 'State' },
      { key: 'promised_on', label: 'Promised on' },
      { key: 'shipped_on', label: 'Shipped on' },
      { key: 'delivered_on', label: 'Delivered on' },
      { key: 'line', label: 'Line' },
      { key: 'product', label: 'Product' },
      { key: 'quantity', label: 'Quantity' },
      ...(may.has('payment.read')
        ? [
            { key: 'unit_price', label: 'Unit price' },
            { key: 'line_total', label: 'Line total' },
            { key: 'order_lines_total', label: 'Order lines total' },
            { key: 'shipping', label: 'Shipping' },
            { key: 'tax', label: 'Tax' },
            { key: 'order_total', label: 'Order total' },
            { key: 'currency', label: 'Currency' },
          ]
        : []),
      ...(may.has('partner.read') ? [{ key: 'partner', label: 'Partner' }] : []),
    ];
  }

  async *pages(ctx: ExportContext<Params>): AsyncIterable<Record<string, CsvCell>[]> {
    const { from, to, customer_id: customerId, states } = ctx.params;
    const placedAt = { gte: startOfLocalDay(from, ctx.timeZone), lt: startOfLocalDay(addDays(to, 1), ctx.timeZone) };

    // An order's number is unique in the workspace, so it alone marks where a page ended.
    for (let last: number | undefined; ; ) {
      const after = last;
      const page = await this.prisma.inTenant(ctx.tenantId, async (tx) => {
        const orders = await tx.order.findMany({
          where: { placedAt, ...(customerId ? { customerId } : {}), ...(after !== undefined ? { number: { gt: after } } : {}) },
          orderBy: { number: 'asc' },
          take: ctx.pageSize,
          include: { customer: { select: { name: true } } },
        });
        const lines = await tx.orderLine.findMany({
          where: { orderId: { in: orders.map((order) => order.id) } },
          orderBy: [{ orderId: 'asc' }, { position: 'asc' }],
          include: { product: { select: { name: true } } },
        });
        const groupIds = lines.flatMap((line) => (line.groupId ? [line.groupId] : []));
        const pieces = await tx.workOrder.findMany({ where: { groupId: { in: groupIds } }, select: { groupId: true, status: true } });
        const holding = await tx.jobAssignment.findMany({
          where: { groupId: { in: groupIds }, status: { in: HOLDING } },
          select: { groupId: true, partner: { select: { name: true } } },
        });
        return { orders, lines, pieces, holding };
      });
      const partnerOf = new Map(page.holding.map((row) => [row.groupId, row.partner.name]));

      const rows: Record<string, CsvCell>[] = [];
      for (const order of page.orders) {
        const lines = page.lines
          .filter((line) => line.orderId === order.id)
          .map((line) => ({ line, state: lineState(page.pieces.filter((piece) => piece.groupId === line.groupId), line.cancelledAt) }));
        const state = orderState(
          lines.map((one) => one.state),
          order.shippedAt,
          order.deliveredAt,
          order.productionStartedAt,
        );
        if (states && !states.includes(state)) continue;
        for (const { line } of lines) {
          rows.push({
            order_number: order.number,
            placed_on: localDate(order.placedAt, ctx.timeZone),
            customer: order.customer.name,
            state,
            promised_on: dayOf(order.promisedOn),
            shipped_on: order.shippedAt ? localDate(order.shippedAt, ctx.timeZone) : null,
            delivered_on: order.deliveredAt ? localDate(order.deliveredAt, ctx.timeZone) : null,
            line: line.position + 1,
            product: line.product.name,
            quantity: line.quantity,
            unit_price: line.unitPrice,
            line_total: line.total,
            order_lines_total: order.linesTotal,
            shipping: order.shippingPrice,
            tax: order.taxAmount,
            order_total: order.total,
            currency: order.currency,
            partner: line.groupId ? (partnerOf.get(line.groupId) ?? null) : null,
          });
        }
      }
      yield rows;
      if (page.orders.length < ctx.pageSize) return;
      last = page.orders[page.orders.length - 1].number;
    }
  }
}
