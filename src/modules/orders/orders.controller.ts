import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { orderResponseSchema } from './order-response';
import type { OrderResponse } from './order-response';
import { OrdersService, cancelOrderSchema, orderListQuerySchema } from './orders.service';
import type { CancelOrder, OrderListQuery } from './orders.service';
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
      'with no partner. A quote of another customer is not found; one already ordered is a 409. A quote past its ' +
      'hold is priced again: unchanged, the order uses the new quote; changed or refused, nothing is placed and the ' +
      "409 has `code: 'price_changed'` with each such line's new quote to order with.",
    body: staffPlaceOrderSchema,
    response: orderResponseSchema,
    errors: [400, 404, 409],
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
    summary: 'Orders, newest first, optionally of one customer, a page at a time.',
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
      'is not used). Once every line is cancelled, so is the order. An unknown line, or an amount for a line not being ' +
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
}
