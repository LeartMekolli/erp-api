import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentCustomer } from '../identity/auth-context';
import type { CustomerAuth } from '../identity/auth-context';
import { CustomerAccess } from '../identity/route-markers';
import { customerOrderResponseSchema, portalShippingMethodsResponseSchema } from './order-response';
import type { CustomerOrderResponse, PortalShippingMethodsResponse } from './order-response';
import { OrdersService } from './orders.service';
import { placeOrderSchema } from './place-order';
import type { PlaceOrder } from './place-order';
import { ShippingMethodsService } from './shipping-methods.service';

const idParam = new ZodValidationPipe(z.uuid());

/** The customer's own orders (Orders spec, goals 1, 10 and 16): never a partner, a partner's cost or a margin. */
@Controller('portal/customers/:customerId')
export class PortalOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly shippingMethods: ShippingMethodsService,
  ) {}

  @ApiDoc({
    summary: 'The shipping methods the customer can choose for a new order, each with its price per order.',
    response: portalShippingMethodsResponseSchema,
    errors: [404],
  })
  @CustomerAccess('viewer')
  @Get('shipping-methods')
  shippingMethodList(@CurrentCustomer() customer: CustomerAuth): Promise<PortalShippingMethodsResponse> {
    return this.shippingMethods.customerList(customer.tenantId);
  }

  @ApiDoc({
    summary: "Order from the customer's quotes, at the prices shown, and start every line.",
    description:
      "Each line is one of the customer's quotes, ordered once; another customer's quote is not found, one already " +
      'ordered is a 409. The totals, tax and promised date are frozen now. A quote past its hold is priced again: ' +
      "unchanged, the order uses the new quote; changed or refused, nothing is placed and the 409 has `code: 'price_changed'` " +
      "with each such line's new quote to order with, or why it can't be priced in plain words. A line at a workshop the " +
      'customer picked that can no longer take it refuses the whole order (409, naming the line).',
    body: placeOrderSchema,
    response: customerOrderResponseSchema,
    errors: [400, 404, 409],
  })
  @CustomerAccess('buyer')
  @Post('orders')
  place(
    @CurrentCustomer() customer: CustomerAuth,
    @Body(new ZodValidationPipe(placeOrderSchema)) body: PlaceOrder,
  ): Promise<CustomerOrderResponse> {
    return this.orders.customerPlace(customer, body);
  }

  @ApiDoc({
    summary: "The customer's orders, newest first, a page at a time.",
    query: paginationQuerySchema,
    response: pageSchema(customerOrderResponseSchema),
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get('orders')
  list(
    @CurrentCustomer() customer: CustomerAuth,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: z.infer<typeof paginationQuerySchema>,
  ): Promise<Page<CustomerOrderResponse>> {
    return this.orders.customerList(customer.tenantId, customer.customerId, query);
  }

  @ApiDoc({
    summary: "One of the customer's orders, with each line's progress through the stages the customer sees.",
    response: customerOrderResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get('orders/:id')
  get(@CurrentCustomer() customer: CustomerAuth, @Param('id', idParam) id: string): Promise<CustomerOrderResponse> {
    return this.orders.customerGet(customer.tenantId, customer.customerId, id);
  }
}
