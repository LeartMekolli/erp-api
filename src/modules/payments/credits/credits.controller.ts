import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Page } from '../../../common/pagination/page';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentCustomer, CurrentTenant, CurrentUser } from '../../identity/auth-context';
import type { CustomerAuth, TenantAuth } from '../../identity/auth-context';
import { CustomerAccess, RequirePermission } from '../../identity/route-markers';
import {
  creditBalanceResponseSchema,
  creditHistoryQuerySchema,
  creditHistoryResponseSchema,
  grantCreditsSchema,
} from './credit-response';
import type { CreditBalanceResponse, CreditEntryResponse, CreditHistoryQuery, GrantCredits } from './credit-response';
import { CreditsService } from './credits.service';

const idParam = new ZodValidationPipe(z.uuid());
const historyQuery = new ZodValidationPipe(creditHistoryQuerySchema);

const BALANCE = 'Credits not expired yet, in the order they are spent: campaign and staff grants, then the monthly allowance, then packs.';

/** A customer's credits (Payments 2 spec, D48): read by staff and by the customer, granted by staff. */
@Controller()
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}

  @ApiDoc({
    summary: "A customer's credit balance, in total, per source and per grant.",
    description: BALANCE,
    response: creditBalanceResponseSchema,
    errors: [404],
  })
  @RequirePermission('payment.read')
  @Get('payments/customers/:id/credits')
  balance(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<CreditBalanceResponse> {
    return this.credits.balanceOf(tenantId, id);
  }

  @ApiDoc({
    summary: "Every movement of a customer's credits, newest first.",
    query: creditHistoryQuerySchema,
    response: creditHistoryResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('payment.read')
  @Get('payments/customers/:id/credits/history')
  history(
    @CurrentTenant() tenantId: string,
    @Param('id', idParam) id: string,
    @Query(historyQuery) query: CreditHistoryQuery,
  ): Promise<Page<CreditEntryResponse>> {
    return this.credits.history(tenantId, id, query);
  }

  @ApiDoc({
    summary: 'Give a customer credits by hand, with a reason, usable to the end of a chosen day.',
    description: "`expires_on` is a day in the workspace's time zone, today at the earliest. Answers the new balance.",
    body: grantCreditsSchema,
    response: creditBalanceResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('credit.grant')
  @Post('payments/customers/:id/credits')
  grant(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(grantCreditsSchema)) body: GrantCredits,
  ): Promise<CreditBalanceResponse> {
    return this.credits.grantByStaff(auth, id, body);
  }

  @ApiDoc({
    summary: "The customer's own credit balance, in total, per source and per grant.",
    description: BALANCE,
    response: creditBalanceResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get('portal/customers/:customerId/credits')
  ownBalance(@CurrentCustomer() customer: CustomerAuth): Promise<CreditBalanceResponse> {
    return this.credits.balanceOf(customer.tenantId, customer.customerId);
  }

  @ApiDoc({
    summary: "Every movement of the customer's own credits, newest first.",
    query: creditHistoryQuerySchema,
    response: creditHistoryResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get('portal/customers/:customerId/credits/history')
  ownHistory(
    @CurrentCustomer() customer: CustomerAuth,
    @Query(historyQuery) query: CreditHistoryQuery,
  ): Promise<Page<CreditEntryResponse>> {
    return this.credits.history(customer.tenantId, customer.customerId, query);
  }
}
