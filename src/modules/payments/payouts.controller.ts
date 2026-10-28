import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination/page';
import type { PaginationQuery } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentPartner, CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { PartnerAuth, TenantAuth } from '../identity/auth-context';
import { PartnerAccess, RequirePermission } from '../identity/route-markers';
import { payoutPageResponseSchema, payoutResponseSchema } from './payment-response';
import type { PayoutPageResponse, PayoutResponse } from './payment-response';
import { PayoutsService } from './payouts.service';

const idParam = new ZodValidationPipe(z.uuid());

/** Paying partners what is due (Payments spec), for staff, and the partner's own payouts. */
@Controller()
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @ApiDoc({
    summary: 'Pay a partner everything due, in one transfer to its payout account.',
    description:
      'What is due is what each job is owed now less what payouts have paid for it, so a raised amount or a job taken ' +
      'back shows here. Answers 202 with the payout `pending`; the transfer follows. A partner without a ready payout ' +
      'account, or with nothing due, is a 409; pressing Pay again while one is pending finds nothing due.',
    response: payoutResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('payment.payout')
  @Post('partners/:id/payouts')
  @HttpCode(202)
  pay(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<PayoutResponse> {
    return this.payouts.pay(auth, id);
  }

  @ApiDoc({
    summary: "A partner's payouts, newest first, a page at a time, each with what it paid per job.",
    query: paginationQuerySchema,
    response: payoutPageResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('payment.read')
  @Get('partners/:id/payouts')
  list(
    @CurrentTenant() tenantId: string,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<PayoutPageResponse> {
    return this.payouts.list(tenantId, id, query);
  }

  @ApiDoc({
    summary: "The partner's payouts, newest first, a page at a time, each with what it paid per job.",
    query: paginationQuerySchema,
    response: payoutPageResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('admin')
  @Get('partner-portal/partners/:partnerId/payouts')
  portalList(
    @CurrentPartner() partner: PartnerAuth,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<PayoutPageResponse> {
    return this.payouts.list(partner.tenantId, partner.partnerId, query);
  }
}
