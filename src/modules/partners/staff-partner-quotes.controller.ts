import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { customerQuoteRequestSchema } from '../pricing/quotes.service';
import { PartnerQuotesService } from './partner-quotes.service';
import { partnerChoicesResponseSchema } from './partner-response';
import type { PartnerChoicesResponse } from './partner-response';

const staffChoicesRequestSchema = customerQuoteRequestSchema.extend({ customer_id: z.uuid() });

/** Staff seeing the workshops a customer may pick, as the customer would (Partners spec, goal 11). */
@Controller('pricing/quotes')
export class StaffPartnerQuotesController {
  constructor(private readonly partnerQuotes: PartnerQuotesService) {}

  @ApiDoc({
    summary: 'The workshops a customer may pick for a configuration, each at the price the customer would pay with it.',
    description:
      "As the customer's own list, acting for `customer_id`: only workshops that take direct orders and can take the " +
      'job right now; nothing is saved. Quote with one by sending its id as `partner_id` to `POST /pricing/quotes`. ' +
      '403 unless the workspace lets the customer pick; a product made of parts is a 400.',
    body: staffChoicesRequestSchema,
    response: partnerChoicesResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('quote.create')
  @Post('partners')
  @HttpCode(200)
  choices(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(staffChoicesRequestSchema)) body: z.infer<typeof staffChoicesRequestSchema>,
  ): Promise<PartnerChoicesResponse> {
    const { customer_id: customerId, ...request } = body;
    return this.partnerQuotes.choices(auth, { customerId, audience: 'staff' }, request);
  }
}
