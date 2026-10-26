import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
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
import { OrdersService, orderListQuerySchema } from './orders.service';
import type { OrderListQuery } from './orders.service';
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
}
