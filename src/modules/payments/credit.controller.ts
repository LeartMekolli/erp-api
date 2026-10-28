import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { orderResponseSchema } from '../orders/order-response';
import type { OrderResponse } from '../orders/order-response';
import { CreditService } from './credit.service';
import { paymentCustomerResponseSchema, releaseOrderSchema } from './payment-response';
import type { PaymentCustomerResponse, ReleaseOrder } from './payment-response';

const idParam = new ZodValidationPipe(z.uuid());

/** Pay-later customers within a credit limit (Payments spec). */
@Controller()
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  @ApiDoc({
    summary: 'Let an order held for its credit limit through, with a reason, so it starts as a pay-later order.',
    description:
      'Its pay link can no longer be paid, and it then counts in what the customer owes. Only an order held for its ' +
      'credit limit that still waits and is not cancelled can be released; anything else is a 409.',
    body: releaseOrderSchema,
    response: orderResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('payment.write')
  @Post('orders/:id/release')
  @HttpCode(200)
  release(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(releaseOrderSchema)) body: ReleaseOrder,
  ): Promise<OrderResponse> {
    return this.credit.release(auth, id, body.reason);
  }

  @ApiDoc({
    summary: "A customer's money: its payment terms, what it owes or will owe, and its open and overdue invoices.",
    response: paymentCustomerResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('payment.read')
  @Get('payments/customers/:id')
  customer(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<PaymentCustomerResponse> {
    return this.credit.customer(tenantId, id);
  }
}
