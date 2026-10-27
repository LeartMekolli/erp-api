import { Controller, Get, Query } from '@nestjs/common';
import type { z } from 'zod';
import { pageSchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { LedgerService } from './ledger.service';
import { ledgerJournalResponseSchema, ledgerQuerySchema } from './payment-response';
import type { LedgerJournalResponse } from './payment-response';

/** Every movement of money, as journals of balanced lines (Payments spec). Read only. */
@Controller('payments/ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @ApiDoc({
    summary: 'The ledger: journals newest first, each with its lines, filtered by order, customer, partner or date.',
    description: 'Debit amounts are positive and credit amounts negative, so the lines of every journal sum to 0.00.',
    query: ledgerQuerySchema,
    response: pageSchema(ledgerJournalResponseSchema),
    errors: [400],
  })
  @RequirePermission('payment.read')
  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: z.infer<typeof ledgerQuerySchema>,
  ): Promise<Page<LedgerJournalResponse>> {
    return this.ledger.list(tenantId, query);
  }
}
