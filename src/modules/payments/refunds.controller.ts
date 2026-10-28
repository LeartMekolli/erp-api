import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { refundSuggestionQuerySchema, refundSuggestionResponseSchema } from './payment-response';
import type { RefundSuggestionQuery, RefundSuggestionResponse } from './payment-response';
import { RefundsService } from './refunds.service';

const idParam = new ZodValidationPipe(z.uuid());

/** Refunds for cancelled orders (Payments spec). */
@Controller()
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @ApiDoc({
    summary: 'Suggest what to refund if some lines of a paid order, or all of it, were cancelled now.',
    description:
      'What the lines cost with their tax, and shipping when every line left goes, less what partners are owed now for ' +
      'work on them, and never more than is left of what was paid. Staff decide the refund when they cancel.',
    query: refundSuggestionQuerySchema,
    response: refundSuggestionResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('payment.refund')
  @Get('orders/:id/refund-suggestion')
  suggestion(
    @CurrentTenant() tenantId: string,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(refundSuggestionQuerySchema)) query: RefundSuggestionQuery,
  ): Promise<RefundSuggestionResponse> {
    const positions = query.lines ? [...new Set(query.lines.split(',').map(Number))] : undefined;
    return this.refunds.suggestion(tenantId, id, positions);
  }
}
