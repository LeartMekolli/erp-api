import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentCustomer, CurrentTenant } from '../identity/auth-context';
import type { CustomerAuth } from '../identity/auth-context';
import { CustomerAccess, RequirePermission } from '../identity/route-markers';
import { CheckoutService } from './checkout.service';
import { payLinkResponseSchema } from './payment-response';
import type { PayLinkResponse } from './payment-response';

const idParam = new ZodValidationPipe(z.uuid());

const DESCRIPTION =
  "A new link for what the order's live lines cost now; any link before it can't be paid any more. " +
  'Only an order waiting for payment gets one: a cancelled, paid or pay-later order is a 409. A 503 when the ' +
  'payment provider does not answer; asking again is safe.';

/** Links to pay for an order that waits for payment (Payments spec). */
@Controller()
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

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
}
