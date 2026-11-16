import { Controller, Get } from '@nestjs/common';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentCustomer } from '../identity/auth-context';
import type { CustomerAuth } from '../identity/auth-context';
import { CustomerAccess } from '../identity/route-markers';
import { AdjustmentsService } from '../pricing/adjustments.service';
import { speedChoicesResponseSchema } from '../pricing/pricing-response';
import type { SpeedChoicesResponse } from '../pricing/pricing-response';

/** The delivery speeds a customer can order at (Customers spec). */
@Controller('portal/customers/:customerId/delivery-speeds')
export class PortalSpeedsController {
  constructor(private readonly adjustments: AdjustmentsService) {}

  @ApiDoc({
    summary: 'The delivery speeds the customer can order at, by key.',
    description: 'Names and working days only; the price of a speed comes with a quote.',
    response: speedChoicesResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get()
  async list(@CurrentCustomer() customer: CustomerAuth): Promise<SpeedChoicesResponse> {
    return { data: await this.adjustments.speedChoices(customer.tenantId, customer.customerId) };
  }
}
