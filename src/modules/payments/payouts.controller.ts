import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination/page';
import type { PaginationQuery } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentPartner, CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { PartnerAuth, TenantAuth } from '../identity/auth-context';
import { PartnerAccess, RequirePermission } from '../identity/route-markers';
import { payRefusedResponseSchema, payoutPageResponseSchema, payoutResponseSchema, portalPayoutPageResponseSchema } from './payment-response';
import type { PayoutPageResponse, PayoutResponse, PortalPayoutPageResponse } from './payment-response';
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
      'back shows here. Answers 202 with the payout `pending`; the transfer follows. Without a ready payout account the ' +
      "409 has `code: 'payout_account_not_ready'`; with nothing due, `code: 'nothing_due'`. Pressing Pay again while " +
      'one is pending finds nothing due.',
    response: payoutResponseSchema,
    errors: [400, 404, { status: 409, schema: payRefusedResponseSchema }],
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
    description: 'Never why the provider refused a transfer, nor the order behind a job; only staff see those.',
    query: paginationQuerySchema,
    response: portalPayoutPageResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('admin')
  @Get('partner-portal/partners/:partnerId/payouts')
  async portalList(
    @CurrentPartner() partner: PartnerAuth,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<PortalPayoutPageResponse> {
    const page = await this.payouts.list(partner.tenantId, partner.partnerId, query);
    // The provider's own words can tell of the workspace's balance, and the orders are the workspace's.
    return {
      ...page,
      data: page.data.map(({ failure: _failure, jobs, ...payout }) => ({ ...payout, jobs: jobs.map(({ order: _order, ...job }) => job) })),
    };
  }
}
