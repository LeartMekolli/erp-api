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
import type { AuditInput } from '../audit/audit.service';
import { customerRefusal } from '../customers/customer-refusals';
import type { CustomerAuth, TenantAuth } from '../identity/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import { creditExposure, overLimit } from '../payments/credit';
import { INVOICE_STATUSES, paidAndRefunded, paymentState } from '../payments/payment-state';
import type { PaymentTerms } from '../payments/payment-state';
import type { QuoteRefusal, QuoteSummaryResponse } from '../pricing/quote-response';
import { QuotesService } from '../pricing/quotes.service';
import { parseSetting } from '../settings/setting-keys';
import { SettingsService } from '../settings/settings.service';
import { WorkOrdersService } from '../workflow/work-orders.service';
import { localDate, promisedDate } from './dates';
import type { BusinessCalendar } from './dates';
import type {
  Address,
  CustomerOrderLineResponse,
  CustomerOrderResponse,
  OrderLineResponse,
  OrderResponse,
} from './order-response';
import { ONE_PARTNER } from './order-lines';
import { lineState, orderState } from './order-state';
import { DEFAULT_CALENDAR, commonSpeed, nextOrderNumber, orderTotals } from './place-order';
import type { PlaceOrder } from './place-order';
import { TAX_CALCULATOR } from './tax';
import type { TaxCalculator } from './tax';

type Tx = Prisma.TransactionClient;
type Channel = 'staff' | 'portal';

export const orderListQuerySchema = paginationQuerySchema.extend({ customer_id: z.uuid().optional() });
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

const reasonSchema = z.string().trim().min(1).max(500);

export const cancelOrderSchema = z.strictObject({
  reason: reasonSchema,
  /** Positions of the lines to cancel; every line not cancelled yet when left out. */
  lines: z.array(z.number().int().min(0)).min(1).max(50).optional(),
  /** What the partner that accepted a cancelled line is owed for it; nothing when left out. */
  partner_owed: z
    .array(
      z.strictObject({
        position: z.number().int().min(0),
        /** For an assembly line: the part whose partner is owed; omitted: the line's own partner. */
        part: z.number().int().min(0).optional(),
        amount: z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'must be an amount with at most 2 places, such as 25.00'),
        reason: reasonSchema,
      }),
    )
    .max(50)
    .refine(
      (owed) => new Set(owed.map((entry) => `${entry.position}:${entry.part ?? ''}`)).size === owed.length,
      'one amount per line or part',
    )
    .optional(),
});
export type CancelOrder = z.infer<typeof cancelOrderSchema>;

export const customerCancelOrderSchema = z.strictObject({ reason: reasonSchema });
export type CustomerCancelOrder = z.infer<typeof customerCancelOrderSchema>;

export const shipOrderSchema = z.strictObject({
  courier: z.string().trim().min(1).max(100).optional(),
  tracking: z.string().trim().min(1).max(200).optional(),
});
export type ShipOrder = z.infer<typeof shipOrderSchema>;

/** Shown in a notification for a courier or tracking number staff didn't give. */
const NOT_GIVEN = '—';

/** Jobs that hold a line: offered or accepted. */
const HOLDING = ['offered', 'accepted'];

export const NOT_PAID_IN_TIME = 'Not paid in time';

const HOUR_MS = 3_600_000;

/**
 * What Payments does when an order waits for payment, registered by Payments so Orders never
 * depends on it. Each runs after the order's change has committed; a failure is logged.
 */
export interface OrderPaymentHooks {
  /** A pay-first order was placed: open its checkout and ask the customer to pay. */
  placed(tenantId: string, orderId: string): Promise<void>;
  /** Lines of a waiting order, or all of it, were cancelled: the open checkout is for the old amount. */
  cancelled(tenantId: string, orderId: string): Promise<void>;
  /** A pay-later order not paid has shipped: invoice it. */
  shipped(tenantId: string, orderId: string): Promise<void>;
}

/** Placing orders and reading them (Orders spec, goals 1–4, 7, 8, 10, 11, 15, 17). */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private paymentHooks: Partial<OrderPaymentHooks> = {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly workOrders: WorkOrdersService,
    private readonly quotes: QuotesService,
    private readonly notifications: NotificationsService,
    @Inject(TAX_CALCULATOR) private readonly tax: TaxCalculator,
  ) {}

  /** Each Payments service registers the hooks it answers for. */
  registerPaymentHooks(hooks: Partial<OrderPaymentHooks>): void {
    this.paymentHooks = { ...this.paymentHooks, ...hooks };
  }

  /**
   * Places an order and starts every line, in one transaction: all of it, or nothing. A line whose
   * quote names a workshop the customer picked becomes that workshop's job through the Partners start
   * hook, which refuses (409, naming the line) when it can no longer take it.
   */
  async place(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, customerId: string, body: PlaceOrder, channel: Channel): Promise<OrderResponse> {
    body = { ...body, lines: await this.refreshLapsed(auth, customerId, body.lines, channel) };
    let afterCommit: (() => Promise<void>)[] = [];
    let placed: OrderResponse;
    try {
      placed = await this.prisma.inTenant(auth.tenantId, async (tx) => {
        // Row-level security hides other workspaces' customers, so a foreign id is simply not found.
        if (!(await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } }))) {
          throw new NotFoundException('Customer not found');
        }
        const quotes = await this.orderable(tx, customerId, body.lines.map((line) => line.quote_id));
        await this.onePartner(tx, quotes);

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
        // The customer's terms as they are now; changing them later leaves this order as placed. A
        // pay-first order waits for its payment: its groups and a picked workshop's job are created
        // now, so the capacity is held, but nothing starts until it is paid (Payments spec, B1).
        // A pay-later order that would take the customer past its credit limit waits the same way, until
        // paid or released. The terms row is locked, so two orders at once are judged one after the other.
        const [row] = await tx.$queryRaw<{ terms: string; credit_limit: Prisma.Decimal | null }[]>`
          SELECT terms, credit_limit FROM customer_payment_terms WHERE customer_id = ${customerId}::uuid FOR UPDATE`;
        const terms = row?.terms ?? 'pay_first';
        const creditLimit = row?.credit_limit ? new Prisma.Decimal(row.credit_limit) : null;
        const heldForCredit = terms === 'pay_later' && overLimit(await creditExposure(tx, customerId), total, creditLimit);
        const payFirst = terms === 'pay_first' || heldForCredit;
        const collection = parseSetting('payments.collection', (await this.settings.list(tx))['payments.collection'] ?? {});

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
            paymentTerms: terms,
            heldForCredit,
            productionStartedAt: payFirst ? null : placedAt,
            payBy: payFirst ? new Date(placedAt.getTime() + collection.payWithinHours * HOUR_MS) : null,
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
          // A waiting order's workshop hears of its job once the order is paid, not now.
          if (!payFirst) afterCommit = [...afterCommit, ...started.afterCommit];

          // An assembly's parts, each started from its own quote under the line's group (Orders spec, goal 6).
          for (const partQuote of await tx.quote.findMany({ where: { parentQuoteId: quote.id }, orderBy: { position: 'asc' } })) {
            const part = await tx.orderLinePart.create({
              data: {
                lineId: line.id,
                position: partQuote.position!,
                quoteId: partQuote.id,
                productId: partQuote.productId,
                quantity: partQuote.quantity,
                unitPrice: partQuote.unitPrice,
                total: partQuote.total,
              },
            });
            const partStarted = await this.startLine(tx, auth, partQuote, part.id, position, started.group.id);
            await tx.orderLinePart.update({ where: { id: part.id }, data: { groupId: partStarted.group.id } });
            if (!payFirst) afterCommit = [...afterCommit, ...partStarted.afterCommit];
          }
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
    // The order has committed: a failure from here on (telling a workshop, the customer, staff) must not report it as failed.
    const number = String(placed.number);
    const subject = { type: 'order', id: placed.id };
    afterCommit = [
      ...afterCommit,
      async () => {
        await this.notifications.raise(auth.tenantId, 'order.placed', subject, { number });
      },
      async () => {
        await this.notifications.raise(auth.tenantId, 'order.received', subject, { number, customer_name: placed.customer.name });
      },
    ];
    for (const after of afterCommit) {
      await this.afterCommit(placed.id, after);
    }
    if (placed.payment.state !== 'awaiting_payment') return placed;
    // Waiting for payment: the checkout is opened now, outside the transaction, and read back.
    await this.afterCommit(placed.id, async () => {
      await this.paymentHooks.placed?.(auth.tenantId, placed.id);
    });
    return this.get(auth.tenantId, placed.id);
  }

  /**
   * Ships a ready order, with the courier and tracking number when given, and tells the customer
   * (Orders spec, goals 9 and 16). An order not ready yet, or shipped already, is a 409.
   */
  async ship(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, id: string, body: ShipOrder): Promise<OrderResponse> {
    const shipped = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const order = await this.lockOrder(tx, id);
      const before = (await this.views(tx, [order]))[0];
      if (before.state !== 'ready') {
        throw new ConflictException(`Only a ready order can be shipped; this one is ${before.state.replace('_', ' ')}`);
      }
      const updated = await tx.order.update({
        where: { id },
        data: { shippedAt: new Date(), courier: body.courier ?? null, tracking: body.tracking ?? null },
      });
      return this.recordChange(tx, auth, before, updated);
    });
    await this.afterCommit(id, async () => {
      await this.notifications.raise(auth.tenantId, 'order.shipped', { type: 'order', id }, {
        number: String(shipped.number),
        courier: shipped.shipping.courier ?? NOT_GIVEN,
        tracking: shipped.shipping.tracking ?? NOT_GIVEN,
      });
    });
    if (shipped.payment.terms === 'pay_later' && shipped.payment.state === 'not_billed') {
      await this.afterCommit(id, async () => {
        await this.paymentHooks.shipped?.(auth.tenantId, id);
      });
    }
    return shipped;
  }

  /** Marks a shipped order delivered, and tells the customer. An order not shipped, or delivered already, is a 409. */
  async deliver(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, id: string): Promise<OrderResponse> {
    const delivered = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const order = await this.lockOrder(tx, id);
      const before = (await this.views(tx, [order]))[0];
      if (before.state !== 'shipped') {
        throw new ConflictException(`Only a shipped order can be delivered; this one is ${before.state.replace('_', ' ')}`);
      }
      const updated = await tx.order.update({ where: { id }, data: { deliveredAt: new Date() } });
      return this.recordChange(tx, auth, before, updated);
    });
    await this.afterCommit(id, async () => {
      await this.notifications.raise(auth.tenantId, 'order.delivered', { type: 'order', id }, { number: String(delivered.number) });
    });
    return delivered;
  }

  /** Audits a change to an order and answers it as staff see it now. */
  private async recordChange(
    tx: Tx,
    auth: Pick<TenantAuth, 'userId'>,
    before: OrderResponse,
    updated: Order,
    actor: AuditInput['actor'] = { type: 'user', id: auth.userId },
  ): Promise<OrderResponse> {
    const after = (await this.views(tx, [updated]))[0];
    await this.audit.record(tx, {
      actor,
      action: 'order.changed',
      subject: { type: 'order', id: updated.id },
      before,
      after,
    });
    return after;
  }

  /** Runs a step once the order's change has committed; a failure is logged, never answered. */
  private async afterCommit(orderId: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.logger.error({ err: error, orderId }, 'a step after changing an order failed');
    }
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

  /** The customer's orders, newest first: the customer's view (Global Constraints). */
  async customerList(tenantId: string, customerId: string, query: z.infer<typeof paginationQuerySchema>): Promise<Page<CustomerOrderResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.order.findMany({
        where: { customerId, ...(after ? { id: { lt: after.id } } : {}) },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const page = toPage(rows, query.limit, secret);
      return { data: await this.customerViews(tx, page.data), next_cursor: page.next_cursor };
    });
  }

  /** One of the customer's orders; another customer's is simply not found. */
  async customerGet(tenantId: string, customerId: string, id: string): Promise<CustomerOrderResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => (await this.customerViews(tx, [await this.customerOrder(tx, customerId, id)]))[0]);
  }

  /** Places an order from the customer app and answers it as the customer sees it. */
  async customerPlace(auth: CustomerAuth, body: PlaceOrder): Promise<CustomerOrderResponse> {
    const placed = await this.place(auth, auth.customerId, body, 'portal');
    return this.customerGet(auth.tenantId, auth.customerId, placed.id);
  }

  /**
   * Staff cancel some lines, or every line left, until the order ships (Orders spec, goal 12). Each
   * line's unfinished pieces are cancelled and its partner let go; an accepted partner is owed what
   * `partner_owed` gives for its line, else nothing. Once every line is cancelled, so is the order.
   */
  async cancel(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, id: string, body: CancelOrder): Promise<OrderResponse> {
    const cancelled = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const order = await this.lockOrder(tx, id);
      return this.cancelLines(tx, auth, order, body);
    });
    await this.afterPaymentChange(auth.tenantId, id);
    // The customer hears of it once the whole order is cancelled; cancelling some lines leaves it open.
    if (cancelled.state === 'cancelled') {
      await this.afterCommit(id, async () => {
        await this.notifications.raise(auth.tenantId, 'order.cancelled', { type: 'order', id }, {
          number: String(cancelled.number),
          reason: body.reason,
        });
      });
    }
    return cancelled;
  }

  /** The customer cancels the whole order, only while no piece of it has been worked on (goal 12). */
  async customerCancel(auth: CustomerAuth, id: string, body: CustomerCancelOrder): Promise<CustomerOrderResponse> {
    const cancelled = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.customerOrder(tx, auth.customerId, id);
      const order = await this.lockOrder(tx, id);
      if (order.cancelledAt) {
        throw new ConflictException('The order is already cancelled');
      }
      const lines = await tx.orderLine.findMany({ where: { orderId: id }, select: { groupId: true, parts: { select: { groupId: true } } } });
      // An assembly's parts count: work on any of them is work on the order.
      const groupIds = lines.flatMap((line) => [line.groupId, ...line.parts.map((part) => part.groupId)]).flatMap((groupId) => (groupId ? [groupId] : []));
      // Any transition at all: a piece has passed or failed a step, or staff corrected one.
      if (await tx.transition.findFirst({ where: { workOrder: { groupId: { in: groupIds } } }, select: { id: true } })) {
        throw new ConflictException('Production has started on this order: please contact us to cancel it');
      }
      await this.cancelLines(tx, auth, order, { reason: body.reason });
    });
    await this.afterPaymentChange(auth.tenantId, id);
    return this.customerGet(auth.tenantId, auth.customerId, id);
  }

  /**
   * Cancels a pay-first order not paid by its deadline, as the system (Payments spec): only while it
   * still waits, is past `pay_by` and is not cancelled; anything else is left as it is and answers
   * false. Its pieces' cancellations name the person who placed it, as every transition names a user.
   */
  async cancelUnpaid(tenantId: string, orderId: string): Promise<boolean> {
    const cancelled = await this.prisma.inTenant(tenantId, async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      if (order.cancelledAt || order.productionStartedAt || !order.payBy || order.payBy > new Date()) return null;
      return this.cancelLines(tx, { tenantId, userId: order.placedByUserId }, order, { reason: NOT_PAID_IN_TIME }, { type: 'system' });
    });
    if (!cancelled) return false;
    await this.afterPaymentChange(tenantId, orderId);
    await this.afterCommit(orderId, async () => {
      await this.notifications.raise(tenantId, 'order.unpaid_cancelled', { type: 'order', id: orderId }, { number: String(cancelled.number) });
    });
    return true;
  }

  /**
   * Starts a waiting order once it is paid (Payments spec), in the caller's transaction: its
   * production starts at `at`, and its promised date is counted from `at` as when it was placed.
   * Answers the groups of its live lines and parts, whose held jobs the caller hands over; null when
   * the order has started already, or is cancelled.
   */
  async startProduction(
    tx: Tx,
    orderId: string,
    at: Date,
    actor: AuditInput['actor'],
  ): Promise<{ number: number; lines: { position: number; groupIds: string[] }[] } | null> {
    const order = await this.lockOrder(tx, orderId);
    if (order.productionStartedAt || order.cancelledAt) return null;
    const before = (await this.views(tx, [order]))[0];
    const promisedOn = promisedDate(at, await this.workingDays(tx, order.deliverySpeedKey), await this.calendar(tx), await this.timezone(tx, order.tenantId));
    const updated = await tx.order.update({
      where: { id: orderId },
      data: { productionStartedAt: at, promisedOn: new Date(`${promisedOn}T00:00:00Z`) },
    });
    await this.recordChange(tx, { userId: actor.id ?? '' }, before, updated, actor);
    const lines = await tx.orderLine.findMany({
      where: { orderId, cancelledAt: null },
      orderBy: { position: 'asc' },
      select: { position: true, groupId: true, parts: { select: { groupId: true } } },
    });
    return {
      number: order.number,
      lines: lines.map((line) => ({
        position: line.position,
        groupIds: [line.groupId, ...line.parts.map((part) => part.groupId)].flatMap((id) => (id ? [id] : [])),
      })),
    };
  }

  /**
   * Staff let an order held for its credit limit through, with a reason (Payments spec, B2): it is no
   * longer held and has no deadline to pay by. The caller then starts it, in the same transaction.
   * Only a held order that still waits and isn't cancelled can be released (409).
   */
  async releaseHeld(tx: Tx, auth: Pick<TenantAuth, 'userId'>, orderId: string, reason: string): Promise<void> {
    const order = await this.lockOrder(tx, orderId);
    if (!order.heldForCredit || order.productionStartedAt || order.cancelledAt) {
      throw new ConflictException('Only an order held for its credit limit, still waiting, can be released');
    }
    const before = (await this.views(tx, [order]))[0];
    const updated = await tx.order.update({
      where: { id: orderId },
      data: { heldForCredit: false, payBy: null, releasedByUserId: auth.userId, releaseReason: reason },
    });
    await this.recordChange(tx, auth, before, updated);
  }

  /** Lets Payments know a waiting order changed, after commit; a failure is logged. */
  private async afterPaymentChange(tenantId: string, orderId: string): Promise<void> {
    await this.afterCommit(orderId, async () => {
      await this.paymentHooks.cancelled?.(tenantId, orderId);
    });
  }

  /** Locks the order row first, as every change to an order does (Global Constraints, lock order). */
  private async lockOrder(tx: Tx, id: string): Promise<Order> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "order" WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) {
      throw new NotFoundException('Order not found');
    }
    return tx.order.findUniqueOrThrow({ where: { id } });
  }

  /** Cancels the chosen lines of a locked order, then the order once no line is left, and audits it. */
  private async cancelLines(
    tx: Tx,
    auth: Pick<TenantAuth, 'tenantId' | 'userId'>,
    order: Order,
    body: CancelOrder,
    actor?: AuditInput['actor'],
  ): Promise<OrderResponse> {
    if (order.shippedAt) {
      throw new ConflictException('A shipped order cannot be cancelled');
    }
    const lines = await tx.orderLine.findMany({ where: { orderId: order.id }, orderBy: { position: 'asc' }, include: { parts: true } });
    for (const [index, position] of (body.lines ?? []).entries()) {
      if (!lines.some((line) => line.position === position)) {
        throw new BadRequestException({ message: 'The order has no such line', errors: [{ path: `lines.${index}`, message: `no line ${position}` }] });
      }
    }
    const chosen = lines.filter((line) => !line.cancelledAt && (body.lines ? body.lines.includes(line.position) : true));
    // A line named twice is one line; one already cancelled can't be again.
    if (chosen.length === 0 || chosen.length < new Set(body.lines ?? []).size) {
      throw new ConflictException(chosen.length === 0 ? 'Nothing left to cancel' : 'A line named is already cancelled');
    }
    const owed = body.partner_owed ?? [];
    for (const [index, entry] of owed.entries()) {
      const line = chosen.find((one) => one.position === entry.position);
      if (!line) {
        throw new BadRequestException({
          message: 'A partner is owed only for a line being cancelled',
          errors: [{ path: `partner_owed.${index}.position`, message: `line ${entry.position} is not being cancelled` }],
        });
      }
      if (entry.part !== undefined && !line.parts.some((part) => part.position === entry.part)) {
        throw new BadRequestException({
          message: 'The line has no such part',
          errors: [{ path: `partner_owed.${index}.part`, message: `line ${entry.position} has no part ${entry.part}` }],
        });
      }
    }

    const before = (await this.views(tx, [order]))[0];
    const now = new Date();
    const owedFor = (position: number, part: number | undefined) => {
      const entry = owed.find((one) => one.position === position && one.part === part);
      return entry && { amount: entry.amount, reason: entry.reason };
    };
    // A line's own group and its parts' (Orders spec, goal 6), each letting go of its own partner.
    await this.workOrders.cancelGroups(
      tx,
      chosen.flatMap((line) => [
        ...(line.groupId ? [{ id: line.groupId, partnerOwed: owedFor(line.position, undefined) }] : []),
        ...line.parts.flatMap((part) => (part.groupId ? [{ id: part.groupId, partnerOwed: owedFor(line.position, part.position) }] : [])),
      ]),
      auth.userId,
      body.reason,
    );
    await tx.orderLine.updateMany({ where: { id: { in: chosen.map((line) => line.id) } }, data: { cancelledAt: now } });
    const left = lines.length - lines.filter((line) => line.cancelledAt).length - chosen.length;
    const updated = left === 0 ? await tx.order.update({ where: { id: order.id }, data: { cancelledAt: now, cancelReason: body.reason } }) : order;
    return this.recordChange(tx, auth, before, updated, actor);
  }

  private async customerOrder(tx: Tx, customerId: string, id: string): Promise<Order> {
    const order = await tx.order.findFirst({ where: { id, customerId } });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }

  /**
   * Prices every lapsed line again, each in its own transaction (Orders spec, goal 2). Unchanged
   * prices are swapped for their new quotes; any change or refusal refuses the order with every
   * lapsed line's outcome, so the customer confirms the new prices first. Lines of other customers,
   * already ordered or unknown, are left for `orderable` to refuse. A customer reads each refusal in
   * plain words, never the pricing setup behind it.
   */
  private async refreshLapsed(
    auth: Pick<TenantAuth, 'tenantId' | 'userId'>,
    customerId: string,
    lines: PlaceOrder['lines'],
    channel: Channel,
  ): Promise<PlaceOrder['lines']> {
    const lapsed = await this.prisma.inTenant(auth.tenantId, (tx) =>
      tx.quote.findMany({
        where: { id: { in: lines.map((line) => line.quote_id) }, customerId, parentQuoteId: null, expiresAt: { lte: new Date() }, orderLine: null },
      }),
    );
    if (lapsed.length === 0) return lines;

    const outcomes = new Map<string, { quote: QuoteSummaryResponse | null; reasons: QuoteRefusal[]; same: boolean }>();
    for (const quote of lapsed) {
      const result = await this.quotes.requote(auth, quote.id);
      outcomes.set(
        quote.id,
        result.accepted
          ? { quote: result.quote, reasons: [], same: new Prisma.Decimal(result.quote.total).equals(quote.total) }
          : { quote: null, reasons: channel === 'portal' ? result.reasons.map(customerRefusal) : result.reasons, same: false },
      );
    }
    if ([...outcomes.values()].every((outcome) => outcome.same)) {
      return lines.map((line) => ({ quote_id: outcomes.get(line.quote_id)?.quote?.id ?? line.quote_id }));
    }
    throw new ConflictException({
      code: 'price_changed',
      message: 'A price shown has changed since; confirm the new prices to order',
      lines: lines.flatMap((line, position) => {
        const outcome = outcomes.get(line.quote_id);
        return outcome ? [{ position, previous_quote_id: line.quote_id, quote: outcome.quote, reasons: outcome.reasons }] : [];
      }),
    });
  }

  /**
   * The quotes of an order's lines, in line order: each the customer's, not ordered yet, and still
   * holding its price. Another customer's or an internal quote is not found.
   */
  private async orderable(tx: Tx, customerId: string, quoteIds: string[]): Promise<Quote[]> {
    const quotes: Quote[] = [];
    for (const [index, quoteId] of quoteIds.entries()) {
      // A part's quote is ordered only with its assembly's.
      const quote = await tx.quote.findFirst({ where: { id: quoteId, customerId, parentQuoteId: null } });
      if (!quote) {
        throw new NotFoundException({ message: 'Quote not found', errors: [{ path: `lines.${index}.quote_id`, message: 'not found' }] });
      }
      if (await tx.orderLine.findFirst({ where: { quoteId }, select: { id: true } })) {
        throw new ConflictException({
          message: 'A quote is ordered once',
          errors: [{ path: `lines.${index}`, message: 'this quote has already been ordered' }],
        });
      }
      // `refreshLapsed` replaced every lapsed quote; one that lapsed in the moments since still holds
      // the price the customer confirmed, so it is ordered as is.
      quotes.push(quote);
    }
    return quotes;
  }

  /**
   * Unless the workspace lets one order's lines go to different partners, every line at a workshop
   * the customer picked names the same one; lines at the workspace's own prices don't count (Orders
   * spec, goal 3). A workspace that never set it may split.
   */
  private async onePartner(tx: Tx, quotes: Quote[]): Promise<void> {
    const routing = (await this.settings.list(tx))['partners.routing'] as { splitOrderLines: boolean } | undefined;
    if (routing?.splitOrderLines !== false) return;
    const first = quotes.find((quote) => quote.partnerId !== null)?.partnerId;
    const errors = quotes.flatMap((quote, position) =>
      quote.partnerId !== null && quote.partnerId !== first ? [{ path: `lines.${position}`, message: ONE_PARTNER }] : [],
    );
    if (errors.length > 0) {
      throw new ConflictException({ message: ONE_PARTNER, errors });
    }
  }

  /**
   * Starts a line, or a part of one under the line's group, from its quote; a refusal names the
   * line, so the customer knows which to change.
   */
  private async startLine(
    tx: Tx,
    auth: Pick<TenantAuth, 'tenantId' | 'userId'>,
    quote: Quote,
    lineId: string,
    position: number,
    parentGroupId?: string,
  ) {
    try {
      return await this.workOrders.startQuoted(tx, auth, quote, { type: 'order_line', id: lineId }, { parentGroupId });
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

  /**
   * Orders as their customer sees them, field by field, so nothing staff-only is carried over by
   * accident: no customer, channel, partner or group; each line's progress instead.
   */
  private async customerViews(tx: Tx, orders: Order[]): Promise<CustomerOrderResponse[]> {
    const views = await this.views(tx, orders);
    const groupIds = views.flatMap((view) =>
      view.lines.flatMap((line) => [line.group_id, ...line.parts.map((part) => part.group_id)]).flatMap((id) => (id ? [id] : [])),
    );
    const groups = await tx.workOrderGroup.findMany({ where: { id: { in: groupIds } } });
    const progress = async (groupId: string | null) => {
      const group = groups.find((one) => one.id === groupId);
      return group ? await this.workOrders.customerProgress(tx, group) : { pieces: [] };
    };
    const responses: CustomerOrderResponse[] = [];
    for (const view of views) {
      const lines: CustomerOrderLineResponse[] = [];
      for (const line of view.lines) {
        const parts: CustomerOrderLineResponse['parts'] = [];
        for (const part of line.parts) {
          parts.push({ position: part.position, product: part.product, quantity: part.quantity, state: part.state, progress: await progress(part.group_id) });
        }
        lines.push({
          id: line.id,
          position: line.position,
          product: line.product,
          quantity: line.quantity,
          unit_price: line.unit_price,
          total: line.total,
          state: line.state,
          progress: await progress(line.group_id),
          parts,
        });
      }
      responses.push({
        id: view.id,
        number: view.number,
        state: view.state,
        promised_on: view.promised_on,
        delivery_speed: view.delivery_speed,
        address: view.address,
        shipping: view.shipping,
        lines,
        lines_total: view.lines_total,
        tax: view.tax,
        total: view.total,
        currency: view.currency,
        note: view.note,
        placed_at: view.placed_at,
        payment: {
          state: view.payment.state,
          pay_by: view.payment.pay_by,
          pay_url: view.payment.pay_url,
          invoice: view.payment.invoice,
          paid: view.payment.paid,
          refunded: view.payment.refunded,
        },
      });
    }
    return responses;
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
      include: {
        product: { select: { id: true, name: true } },
        parts: { orderBy: { position: 'asc' }, include: { product: { select: { id: true, name: true } } } },
      },
    });
    const groupIds = lines
      .flatMap((line) => [line.groupId, ...line.parts.map((part) => part.groupId)])
      .flatMap((groupId) => (groupId ? [groupId] : []));
    const holding = await tx.jobAssignment.findMany({
      where: { groupId: { in: groupIds }, status: { in: HOLDING } },
      include: { partner: { select: { id: true, name: true } } },
    });
    const partnerOf = new Map(holding.map((row) => [row.groupId, row.partner]));
    const pieces = await tx.workOrder.findMany({ where: { groupId: { in: groupIds } }, select: { groupId: true, status: true } });
    // What was paid and refunded comes from the ledger (Payments spec).
    const journals = await tx.ledgerJournal.findMany({
      where: { orderId: { in: ids }, kind: { in: ['payment_received', 'refund'] } },
      select: { orderId: true, kind: true, lines: { select: { account: true, amount: true } } },
    });
    const releasers = await tx.user.findMany({
      where: { id: { in: orders.flatMap((order) => (order.releasedByUserId ? [order.releasedByUserId] : [])) } },
      select: { id: true, name: true },
    });
    const today = localDate(new Date(), await this.timezone(tx, orders[0].tenantId));
    // A waiting order's open checkout, once the provider has given it a link.
    const openCheckouts = await tx.orderPayment.findMany({
      where: { orderId: { in: ids }, status: 'open', url: { not: null } },
      select: { orderId: true, url: true },
    });
    // An invoice once the provider has made it; one still being made is not shown.
    const invoices = await tx.invoice.findMany({
      where: { orderId: { in: ids }, status: { in: [...INVOICE_STATUSES] } },
      select: { orderId: true, url: true, dueOn: true, status: true },
    });

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
          state: lineState(pieces.filter((piece) => piece.groupId === line.groupId), line.cancelledAt),
          group_id: line.groupId,
          partner: line.groupId ? (partnerOf.get(line.groupId) ?? null) : null,
          parts: line.parts.map((part) => ({
            id: part.id,
            position: part.position,
            product: part.product,
            quantity: part.quantity,
            unit_price: part.unitPrice.toFixed(2),
            total: part.total.toFixed(2),
            // A cancelled line's parts are cancelled with it.
            state: lineState(pieces.filter((piece) => piece.groupId === part.groupId), line.cancelledAt),
            group_id: part.groupId,
            partner: part.groupId ? (partnerOf.get(part.groupId) ?? null) : null,
          })),
        }));
      const { paid, refunded } = paidAndRefunded(journals.filter((journal) => journal.orderId === order.id));
      const releaser = releasers.find((user) => user.id === order.releasedByUserId);
      const terms = order.paymentTerms as PaymentTerms;
      const found = invoices.find((row) => row.orderId === order.id);
      const invoice = found?.url
        ? { url: found.url, due_on: found.dueOn.toISOString().slice(0, 10), status: found.status as (typeof INVOICE_STATUSES)[number] }
        : null;
      return {
        id: order.id,
        number: order.number,
        customer: customers.find((customer) => customer.id === order.customerId)!,
        channel: order.channel as Channel,
        state: orderState(orderLines.map((line) => line.state), order.shippedAt, order.deliveredAt, order.productionStartedAt),
        promised_on: order.promisedOn.toISOString().slice(0, 10),
        delivery_speed: order.deliverySpeedKey,
        address: order.address as Address,
        shipping: {
          method: { key: method.key, name: method.name },
          price: order.shippingPrice.toFixed(2),
          courier: order.courier,
          tracking: order.tracking,
          shipped_at: order.shippedAt?.toISOString() ?? null,
          delivered_at: order.deliveredAt?.toISOString() ?? null,
        },
        lines: orderLines,
        lines_total: order.linesTotal.toFixed(2),
        tax: { percent: order.taxPercent.toFixed(), amount: order.taxAmount.toFixed(2) },
        total: order.total.toFixed(2),
        currency: order.currency,
        note: order.note,
        placed_at: order.placedAt.toISOString(),
        payment: {
          terms,
          state: paymentState({
            terms,
            cancelled: order.cancelledAt !== null,
            started: order.productionStartedAt !== null,
            paid,
            refunded,
            invoice: invoice && { status: invoice.status, dueOn: invoice.due_on },
            today,
          }),
          pay_by: order.payBy?.toISOString() ?? null,
          held_for_credit: order.heldForCredit,
          released: releaser && order.releaseReason ? { by: releaser, reason: order.releaseReason } : null,
          paid: paid.toFixed(2),
          refunded: refunded.toFixed(2),
          // A waiting order's checkout, or else an open invoice's page, where it is paid too.
          pay_url:
            openCheckouts.find((checkout) => checkout.orderId === order.id)?.url ?? (invoice?.status === 'open' ? invoice.url : null),
          invoice,
        },
      };
    });
  }
}
