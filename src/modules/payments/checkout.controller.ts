import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentCustomer, CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { CustomerAuth, TenantAuth } from '../identity/auth-context';
import { CustomerAccess, RequirePermission } from '../identity/route-markers';
import { orderResponseSchema } from '../orders/order-response';
import type { OrderResponse } from '../orders/order-response';
import { CheckoutService } from './checkout.service';
import { PaidByHandService } from './paid-by-hand.service';
import { orderPaymentsResponseSchema, paidByHandSchema, payLinkResponseSchema } from './payment-response';
import type { OrderPaymentsResponse, PaidByHand, PayLinkResponse } from './payment-response';

const idParam = new ZodValidationPipe(z.uuid());

const DESCRIPTION =
  "A new link for what the order's live lines cost now; any link before it can't be paid any more. " +
  'Only an order waiting for payment gets one: a cancelled, paid or pay-later order is a 409. A 503 when the ' +
  'payment provider does not answer; asking again is safe.';

/** Links to pay for an order that waits for payment (Payments spec). */
@Controller()
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly byHand: PaidByHandService,
  ) {}

  @ApiDoc({
    summary: 'Get a link to pay for an order waiting for payment.',
    description: DESCRIPTION,
    response: payLinkResponseSchema,
    errors: [400, 404, 409, 503],
  })
  @CustomerAccess('buyer')
  @Post('portal/customers/:customerId/orders/:id/pay')
  @HttpCode(200)
  async pay(@CurrentCustomer() customer: CustomerAuth, @Param('id', idParam) id: string): Promise<PayLinkResponse> {
    return { url: (await this.checkout.open(customer.tenantId, id, customer.customerId)).url };
  }

  @ApiDoc({
    summary: 'Get a link to send the customer, to pay for an order waiting for payment.',
    description: DESCRIPTION,
    response: payLinkResponseSchema,
    errors: [400, 404, 409, 503],
  })
  @RequirePermission('order.write')
  @Post('orders/:id/pay-link')
  @HttpCode(200)
  async payLink(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<PayLinkResponse> {
    return { url: (await this.checkout.open(tenantId, id)).url };
  }

  @ApiDoc({
    summary: 'Record a payment for an order made outside the payment provider, such as a bank transfer.',
    description:
      'An order waiting for payment is billed, paid and starts; an order with an open invoice has it paid, and marked ' +
      'paid outside at the provider. No fee is recorded. An order paid, cancelled, or with nothing billed yet is a 409.',
    body: paidByHandSchema,
    response: orderResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('payment.write')
  @Post('orders/:id/paid-by-hand')
  @HttpCode(200)
  paidByHand(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(paidByHandSchema)) body: PaidByHand,
  ): Promise<OrderResponse> {
    return this.byHand.record(auth, id, body);
  }

  @ApiDoc({
    summary: 'How an order is paid: its payment state, its checkouts and the ledger journals behind it.',
    response: orderPaymentsResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('payment.read')
  @Get('orders/:id/payments')
  payments(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<OrderPaymentsResponse> {
    return this.checkout.overview(tenantId, id);
  }
}
