import { Body, Controller, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { paymentTermsResponseSchema, setPaymentTermsSchema } from './payment-response';
import type { PaymentTermsResponse, SetPaymentTerms } from './payment-response';
import { PaymentTermsService } from './payment-terms.service';

const idParam = new ZodValidationPipe(z.uuid());

/** A customer's payment terms, set by staff (Payments spec). */
@Controller('customers/:id/payment-terms')
export class PaymentTermsController {
  constructor(private readonly terms: PaymentTermsService) {}

  @ApiDoc({
    summary: 'Set how a customer pays: first, or later within some days and up to a credit limit.',
    description:
      'Replaces the terms as a whole: days to pay defaults to 30 and the credit limit to none. Orders already placed ' +
      'keep the terms they were placed under. Customers never see their terms.',
    body: setPaymentTermsSchema,
    response: paymentTermsResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('payment.write')
  @Put()
  set(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(setPaymentTermsSchema)) body: SetPaymentTerms,
  ): Promise<PaymentTermsResponse> {
    return this.terms.set(auth, id, body);
  }
}
