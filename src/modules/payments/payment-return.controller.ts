import { Controller, Get, Header, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { Public } from '../identity/route-markers';

export const paymentReturnQuerySchema = z.object({ outcome: z.enum(['paid', 'cancelled', 'back']) });

const MESSAGES: Record<z.infer<typeof paymentReturnQuerySchema>['outcome'], string> = {
  paid: 'Payment received. You can close this tab.',
  cancelled: 'Payment cancelled; nothing was charged. You can close this tab.',
  back: 'You can close this tab.',
};

/**
 * Where the payment provider sends a customer back to when the workspace has no customer site
 * (`customerOrderLink`, `customerBillingLink`). A fixed page naming no workspace, order or customer.
 */
@Controller('payment-return')
export class PaymentReturnController {
  @ApiDoc({
    summary: 'The page a customer lands on after paying, when the workspace has no customer site.',
    description: 'Plain HTML, the same for every workspace: it says whether the payment went through, and that the tab can be closed.',
    query: paymentReturnQuerySchema,
    errors: [400],
  })
  @Public()
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(@Query(new ZodValidationPipe(paymentReturnQuerySchema)) query: z.infer<typeof paymentReturnQuerySchema>): string {
    const message = MESSAGES[query.outcome];
    return (
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<title>${message}</title></head><body><p>${message}</p></body></html>`
    );
  }
}
