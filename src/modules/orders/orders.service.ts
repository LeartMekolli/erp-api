import { BadRequestException, ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import { paginationQuerySchema, toPage } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { Order, Quote } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { SettingsService } from '../settings/settings.service';
import { WorkOrdersService } from '../workflow/work-orders.service';
import { promisedDate } from './dates';
import type { BusinessCalendar } from './dates';
import type { Address, OrderLineResponse, OrderResponse } from './order-response';
import { DEFAULT_CALENDAR, commonSpeed, nextOrderNumber, orderTotals } from './place-order';
import type { PlaceOrder } from './place-order';
import { TAX_CALCULATOR } from './tax';
import type { TaxCalculator } from './tax';

type Tx = Prisma.TransactionClient;
type Channel = 'staff' | 'portal';

export const orderListQuerySchema = paginationQuerySchema.extend({ customer_id: z.uuid().optional() });
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

/** Jobs that hold a line: offered or accepted. */
const HOLDING = ['offered', 'accepted'];

/** Placing orders and reading them (Orders spec, goals 1–4, 7, 8, 10, 11, 15, 17). */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly workOrders: WorkOrdersService,
    @Inject(TAX_CALCULATOR) private readonly tax: TaxCalculator,
  ) {}

  /**
   * Places an order and starts every line, in one transaction: all of it, or nothing. A line whose
   * quote names a workshop the customer picked becomes that workshop's job through the Partners start
   * hook, which refuses (409, naming the line) when it can no longer take it.
   */
  async place(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, customerId: string, body: PlaceOrder, channel: Channel): Promise<OrderResponse> {
    let afterCommit: (() => Promise<void>)[] = [];
    let placed: OrderResponse;
    try {
      placed = await this.prisma.inTenant(auth.tenantId, async (tx) => {
        // Row-level security hides other workspaces' customers, so a foreign id is simply not found.
        if (!(await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } }))) {
          throw new NotFoundException('Customer not found');
        }
        const quotes = await this.orderable(tx, customerId, body.lines.map((line) => line.quote_id));

        const speed = commonSpeed(quotes.map((quote) => (quote.inputs as { delivery_speed: string | null }).delivery_speed));
        if (!speed.ok) {
          throw new BadRequestException({
            message: 'Every line of an order is made at one delivery speed',
            errors: [{ path: 'lines', message: 'the quotes name different delivery speeds' }],
          });
        }
        const method = await tx.shippingMethod.findFirst({ where: { key: body.shipping_method, active: true } });
        if (!method) {
          throw new BadRequestException({
            message: 'Pick a shipping method the workspace offers',
            errors: [{ path: 'shipping_method', message: `${body.shipping_method} is not an active shipping method` }],
          });
        }

        const placedAt = new Date();
        const promisedOn = promisedDate(placedAt, await this.workingDays(tx, speed.speed), await this.calendar(tx), await this.timezone(tx, auth.tenantId));
        const lineTotals = quotes.map((quote) => quote.total);
        const linesOnly = orderTotals(lineTotals, new Prisma.Decimal(0), new Prisma.Decimal(0)).linesTotal;
        const tax = await this.tax.calculate(tx, {
          customerId,
          address: { country: body.address.country, region: body.address.region ?? null },
          lines: linesOnly,
          shipping: method.price,
        });
        const { linesTotal, total } = orderTotals(lineTotals, method.price, tax.amount);

        const order = await tx.order.create({
          data: {
            number: await nextOrderNumber(tx),
            customerId,
            channel,
            channelOrderId: body.channel_order_id ?? null,
            deliverySpeedKey: speed.speed,
            promisedOn: new Date(`${promisedOn}T00:00:00Z`),
            address: body.address,
            shippingMethodId: method.id,
            shippingPrice: method.price,
            linesTotal,
            taxPercent: tax.percent,
            taxAmount: tax.amount,
            total,
            currency: quotes[0].currency,
            note: body.note ?? null,
            placedByUserId: auth.userId,
            placedAt,
          },
        });

        for (const [position, quote] of quotes.entries()) {
          const line = await tx.orderLine.create({
            data: {
              orderId: order.id,
              position,
              quoteId: quote.id,
              productId: quote.productId,
              quantity: quote.quantity,
              unitPrice: quote.unitPrice,
              total: quote.total,
            },
          });
          const started = await this.startLine(tx, auth, quote, line.id, position);
          await tx.orderLine.update({ where: { id: line.id }, data: { groupId: started.group.id } });
          afterCommit = [...afterCommit, ...started.afterCommit];
        }

        const response = (await this.views(tx, [order]))[0];
        await this.audit.record(tx, {
          actor: { type: 'user', id: auth.userId },
          action: 'order.changed',
          subject: { type: 'order', id: order.id },
          after: response,
        });
        return response;
      });
    } catch (error) {
      // Two orders of one quote at once meet the unique quote on its line; a channel's order id, its own.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This order, or one of its quotes, has just been placed');
      }
      throw error;
    }
    // The order has committed: a failure from here on (telling a workshop) must not report it as failed.
    for (const after of afterCommit) {
      try {
        await after();
      } catch (error) {
        this.logger.error({ err: error, orderId: placed.id }, 'a step after placing an order failed');
      }
    }
    return placed;
  }

  async list(tenantId: string, query: OrderListQuery): Promise<Page<OrderResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.order.findMany({
        where: { ...(query.customer_id ? { customerId: query.customer_id } : {}), ...(after ? { id: { lt: after.id } } : {}) },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const page = toPage(rows, query.limit, secret);
      return { data: await this.views(tx, page.data), next_cursor: page.next_cursor };
    });
  }

  /** Row-level security hides other workspaces' orders, so a foreign id is simply not found. */
  async get(tenantId: string, id: string): Promise<OrderResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const order = await tx.order.findUnique({ where: { id } });
      if (!order) {
        throw new NotFoundException('Order not found');
      }
      return (await this.views(tx, [order]))[0];
    });
  }

  /**
   * The quotes of an order's lines, in line order: each the customer's, not ordered yet, and still
   * holding its price. Another customer's or an internal quote is not found.
   */
  private async orderable(tx: Tx, customerId: string, quoteIds: string[]): Promise<Quote[]> {
    const quotes: Quote[] = [];
    for (const [index, quoteId] of quoteIds.entries()) {
      const quote = await tx.quote.findFirst({ where: { id: quoteId, customerId } });
      if (!quote) {
        throw new NotFoundException({ message: 'Quote not found', errors: [{ path: `lines.${index}.quote_id`, message: 'not found' }] });
      }
      if (await tx.orderLine.findFirst({ where: { quoteId }, select: { id: true } })) {
        throw new ConflictException({
          message: 'A quote is ordered once',
          errors: [{ path: `lines.${index}`, message: 'this quote has already been ordered' }],
        });
      }
      if (quote.expiresAt.getTime() <= Date.now()) {
        throw new ConflictException({
          message: 'The price shown has expired; price it again to order',
          errors: [{ path: `lines.${index}`, message: 'the quote has expired' }],
        });
      }
      quotes.push(quote);
    }
    return quotes;
  }

  /** Starts a line from its quote; a refusal names the line, so the customer knows which to change. */
  private async startLine(tx: Tx, auth: Pick<TenantAuth, 'tenantId' | 'userId'>, quote: Quote, lineId: string, position: number) {
    try {
      return await this.workOrders.startQuoted(tx, auth, quote, { type: 'order_line', id: lineId });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 409) {
        const response = error.getResponse();
        const message = typeof response === 'object' && response !== null && 'message' in response ? String(response.message) : error.message;
        throw new ConflictException({ message, errors: [{ path: `lines.${position}`, message }] });
      }
      throw error;
    }
  }

  private async workingDays(tx: Tx, speedKey: string | null): Promise<number> {
    if (!speedKey) return 0;
    const speed = await tx.deliverySpeed.findFirst({ where: { key: speedKey }, select: { workingDays: true } });
    return speed?.workingDays ?? 0;
  }

  private async calendar(tx: Tx): Promise<BusinessCalendar> {
    const calendar = (await this.settings.list(tx))['business.calendar'] as BusinessCalendar | undefined;
    return calendar ?? DEFAULT_CALENDAR;
  }

  private async timezone(tx: Tx, tenantId: string): Promise<string> {
    return (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } })).timezone;
  }

  /** Orders as staff see them, in the given order, read with one query per kind of fact. */
  private async views(tx: Tx, orders: Order[]): Promise<OrderResponse[]> {
    if (orders.length === 0) return [];
    const ids = orders.map((order) => order.id);
    const customers = await tx.customer.findMany({
      where: { id: { in: [...new Set(orders.map((order) => order.customerId))] } },
      select: { id: true, name: true },
    });
    const methods = await tx.shippingMethod.findMany({ where: { id: { in: [...new Set(orders.map((order) => order.shippingMethodId))] } } });
    const lines = await tx.orderLine.findMany({
      where: { orderId: { in: ids } },
      orderBy: [{ orderId: 'asc' }, { position: 'asc' }],
      include: { product: { select: { id: true, name: true } } },
    });
    const groupIds = lines.flatMap((line) => (line.groupId ? [line.groupId] : []));
    const holding = await tx.jobAssignment.findMany({
      where: { groupId: { in: groupIds }, status: { in: HOLDING } },
      include: { partner: { select: { id: true, name: true } } },
    });
    const partnerOf = new Map(holding.map((row) => [row.groupId, row.partner]));

    return orders.map((order) => {
      const method = methods.find((one) => one.id === order.shippingMethodId)!;
      const orderLines: OrderLineResponse[] = lines
        .filter((line) => line.orderId === order.id)
        .map((line) => ({
          id: line.id,
          position: line.position,
          product: line.product,
          quantity: line.quantity,
          unit_price: line.unitPrice.toFixed(2),
          total: line.total.toFixed(2),
          // Ready, shipped and cancelled lines and orders come with cancelling and shipping (plan Tasks 7–8).
          state: 'in_production',
          group_id: line.groupId,
          partner: line.groupId ? (partnerOf.get(line.groupId) ?? null) : null,
        }));
      return {
        id: order.id,
        number: order.number,
        customer: customers.find((customer) => customer.id === order.customerId)!,
        channel: order.channel as Channel,
        state: 'in_production',
        promised_on: order.promisedOn.toISOString().slice(0, 10),
        delivery_speed: order.deliverySpeedKey,
        address: order.address as Address,
        shipping: {
          method: { key: method.key, name: method.name },
          price: order.shippingPrice.toFixed(2),
          courier: null,
          tracking: null,
          shipped_at: null,
          delivered_at: null,
        },
        lines: orderLines,
        lines_total: order.linesTotal.toFixed(2),
        tax: { percent: order.taxPercent.toFixed(), amount: order.taxAmount.toFixed(2) },
        total: order.total.toFixed(2),
        currency: order.currency,
        note: order.note,
        placed_at: order.placedAt.toISOString(),
      };
    });
  }
}
