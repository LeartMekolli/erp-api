import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { bulkShipResponseSchema, orderCountsResponseSchema, orderResponseSchema } from './order-response';
import type { BulkShipResponse, OrderCountsResponse, OrderResponse } from './order-response';
import { OrdersService, cancelOrderSchema, orderCountsQuerySchema, orderListQuerySchema, shipManySchema, shipOrderSchema } from './orders.service';
import type { CancelOrder, OrderCountsQuery, OrderListQuery, ShipMany, ShipOrder } from './orders.service';
import { staffPlaceOrderSchema } from './place-order';
import type { StaffPlaceOrder } from './place-order';

const idParam = new ZodValidationPipe(z.uuid());

/** Orders, as staff place and follow them (Orders spec). */
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @ApiDoc({
    summary: 'Place an order for a customer from the quotes it was shown, and start every line.',
    description:
      'Each line is a quote of the customer, ordered once, at its price. The totals, tax and promised date are frozen ' +
      "now. A line whose quote names a workshop the customer picked starts as that workshop's job; if the workshop can " +
      'no longer take it, the whole order is refused (409, naming the line) and nothing is created. Other lines start ' +
      "with no partner. Unless the workspace's `partners.routing.splitOrderLines` is on, lines picked at different " +
      'workshops are a 409 naming each line that differs from the first. A quote of another customer is not found; one already ordered is a 409. A quote past its ' +
      'hold is priced again: unchanged, the order uses the new quote; changed or refused, nothing is placed and the ' +
      "409 has `code: 'price_changed'` with each such line's new quote to order with. A live-rate shipping method is " +
      'priced now by the courier service: no rate for it is a 400 on `shipping_method`, a service that fails a 503.',
    body: staffPlaceOrderSchema,
    response: orderResponseSchema,
    errors: [400, 404, 409, 503],
  })
  @RequirePermission('order.write')
  @Post()
  place(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(staffPlaceOrderSchema)) body: StaffPlaceOrder,
  ): Promise<OrderResponse> {
    const { customer_id, ...order } = body;
    return this.orders.place(auth, customer_id, order, 'staff');
  }

  @ApiDoc({
    summary: "Ship up to 25 orders in one request, each as shipping one order does, and answer each one's result.",
    description:
      'Each entry is an order and the options shipping it alone takes (`courier` and `tracking`, or `label`). Up to 5 ' +
      'ship at the same time while you wait. One failing never stops or undoes another: its `error` is what shipping ' +
      'it alone would have answered, with its status, its `code` when it has one, and its detail; an order not found ' +
      'is a failed 404. A malformed request, more than 25 entries or an order listed twice is a 400, and nothing ' +
      'ships. A replayed answer includes its failed entries: to try those again, send them in a new request with a ' +
      'new key.',
    body: shipManySchema,
    response: bulkShipResponseSchema,
    errors: [400],
  })
  @RequirePermission('order.ship')
  @Post('ship')
  @HttpCode(200)
  shipMany(@CurrentUser() auth: TenantAuth, @Body(new ZodValidationPipe(shipManySchema)) body: ShipMany): Promise<BulkShipResponse> {
    return this.orders.shipMany(auth, body);
  }

  @ApiDoc({
    summary: 'Orders, filtered, searched and sorted, a page at a time.',
    description:
      '`state` and `payment_state` take one or more values, comma-separated (`state=ready,in_production`); an unknown ' +
      'value is a 400. `promised_after` includes its day and `promised_before` excludes its day. `q` matches part of ' +
      "the order number (a leading `#` is dropped) or part of the customer's name, case-insensitive. `needs` lists " +
      'orders matching any of the reasons given: `late` (promised before today, not shipped), `to_ship` (ready), ' +
      '`to_collect` (an overdue invoice, or waiting for payment) and `due_soon` (promised from today to 2 working days ' +
      "on, not made yet); each order's own `needs` says which it matches, by the same rule. Filters combine " +
      'with AND. An order whose state is not computed yet is in no `state` or `payment_state` filter until the hourly ' +
      'refresh stores it. Newest first unless `sort` says otherwise; send the same filters and sort with each page, and ' +
      'a cursor made for another sort is a 400.',
    query: orderListQuerySchema,
    response: pageSchema(orderResponseSchema),
    errors: [400],
  })
  @RequirePermission('order.read')
  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(orderListQuerySchema)) query: OrderListQuery,
  ): Promise<Page<OrderResponse>> {
    return this.orders.list(tenantId, query);
  }

  @ApiDoc({
    summary: "How many orders each tab and each needs-you reason holds, with the list's filters.",
    description:
      "Takes the list's `customer_id`, `payment_state`, `promised_after`, `promised_before` and `q`, with the same " +
      'meaning; `state`, `needs`, paging and `sort` pick a tab or a page, and are a 400 here. `all` counts every ' +
      'order the filters pick; `states` and `needs_you` count only orders whose state is computed. ' +
      '`needs_you.total` counts an order matching several reasons once, so it can be less than their sum.',
    query: orderCountsQuerySchema,
    response: orderCountsResponseSchema,
    errors: [400],
  })
  @RequirePermission('order.read')
  @Get('counts')
  counts(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(orderCountsQuerySchema)) query: OrderCountsQuery,
  ): Promise<OrderCountsResponse> {
    return this.orders.counts(tenantId, query);
  }

  @ApiDoc({ summary: 'An order with its lines and totals.', response: orderResponseSchema, errors: [400, 404] })
  @RequirePermission('order.read')
  @Get(':id')
  get(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<OrderResponse> {
    return this.orders.get(tenantId, id);
  }

  @ApiDoc({
    summary: 'Cancel some lines of an order, or every line left, until it ships.',
    description:
      "Each line's unfinished pieces are cancelled. A partner's open offer on it is withdrawn; a partner that had " +
      'accepted it is owed its `partner_owed` amount at once, else nothing (an amount for a line no partner accepted ' +
      'is not used). Once every line is cancelled, so is the order, and the customer is told. An unknown line, or an amount for a line not being ' +
      'cancelled, is a 400; a shipped order, a line already cancelled, or nothing left to cancel is a 409.',
    body: cancelOrderSchema,
    response: orderResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('order.write')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(cancelOrderSchema)) body: CancelOrder,
  ): Promise<OrderResponse> {
    return this.orders.cancel(auth, id, body);
  }

  @ApiDoc({
    summary: 'Ship a ready order, with its courier and tracking number when given, and tell the customer.',
    description:
      'Only once every line is ready or cancelled, with at least one ready; else, or once shipped, a 409. With `label`, ' +
      "the label is bought from the workspace's courier service first, while you wait: the parcel, carrier and service " +
      "default to the shipping method's, and missing any is a 400. No courier account, or a label already being bought, " +
      'is a 409. A refusal by the courier service is a 503 with its reason, and the order stays ready; trying again ' +
      'never buys a second label.',
    body: shipOrderSchema,
    response: orderResponseSchema,
    errors: [400, 404, 409, 503],
  })
  @RequirePermission('order.ship')
  @Post(':id/ship')
  @HttpCode(200)
  ship(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(shipOrderSchema)) body: ShipOrder,
  ): Promise<OrderResponse> {
    return this.orders.ship(auth, id, body);
  }

  @ApiDoc({
    summary: 'Mark a shipped order delivered, and tell the customer.',
    description: 'An order not shipped yet, or delivered already, is a 409.',
    response: orderResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('order.ship')
  @Post(':id/deliver')
  @HttpCode(200)
  deliver(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<OrderResponse> {
    return this.orders.deliver(auth, id);
  }
}
