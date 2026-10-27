import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination/page';
import type { PaginationQuery } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentPartner, CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { PartnerAuth, TenantAuth } from '../identity/auth-context';
import { PartnerAccess, RequirePermission } from '../identity/route-markers';
import { EligibilityService } from './eligibility.service';
import { JobsService, offerSchema, reassignSchema, setOwedSchema } from './jobs.service';
import {
  eligiblePartnersResponseSchema,
  jobAssignmentResponseSchema,
  jobHistoryResponseSchema,
  owedJobResponseSchema,
  partnerOwedResponseSchema,
} from './partner-response';
import type {
  EligiblePartnersResponse,
  JobAssignmentResponse,
  JobHistoryResponse,
  OwedJobResponse,
  PartnerOwedResponse,
} from './partner-response';

const idParam = new ZodValidationPipe(z.uuid());

export const eligibleQuerySchema = z.object({ group_id: z.uuid() });

/**
 * Staff hand jobs to partners (Partners spec, goals 9 and 10). Registered before `PartnersController`,
 * so `/partners/eligible` is not read as a partner id.
 */
@Controller('partners')
export class JobsController {
  constructor(
    private readonly eligibility: EligibilityService,
    private readonly jobs: JobsService,
  ) {}

  @ApiDoc({
    summary:
      "The partners who can take a job, best score first, then cheapest, with cost, margin, room and score; and those who can't, with why.",
    description:
      "A job is a work order group started from a quote. Margin is the quote total less the partner's cost. " +
      'Room is what each partner step would have left after the job, within one capacity period.',
    query: eligibleQuerySchema,
    response: eligiblePartnersResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('partner.assign')
  @Get('eligible')
  eligible(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(eligibleQuerySchema)) query: z.infer<typeof eligibleQuerySchema>,
  ): Promise<EligiblePartnersResponse> {
    return this.eligibility.list(tenantId, query.group_id);
  }

  @ApiDoc({
    summary: "Offer a job to a partner who can take it, until the workspace's deadline.",
    description:
      "Refused with 409 while the job is offered or accepted already, or when the partner can't take it, with the reasons in `errors`. " +
      "Unless the workspace's `partners.routing.splitOrderLines` is on, an order line goes only to the partner holding the order's other lines (409).",
    body: offerSchema,
    response: jobAssignmentResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('partner.assign')
  @Post('jobs/:groupId/offer')
  offer(
    @CurrentUser() auth: TenantAuth,
    @Param('groupId', idParam) groupId: string,
    @Body(new ZodValidationPipe(offerSchema)) body: z.infer<typeof offerSchema>,
  ): Promise<JobAssignmentResponse> {
    return this.jobs.offer(auth, groupId, body.partner_id);
  }

  @ApiDoc({
    summary: "Take back an offer the partner hasn't answered.",
    response: jobAssignmentResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('partner.assign')
  @Post('jobs/:groupId/withdraw')
  @HttpCode(200)
  withdraw(@CurrentUser() auth: TenantAuth, @Param('groupId', idParam) groupId: string): Promise<JobAssignmentResponse> {
    return this.jobs.withdraw(auth, groupId);
  }

  @ApiDoc({
    summary: 'Move an accepted job to another partner, who has it at once.',
    description:
      "For when the partner can't finish it; staff arrange it with the new partner first, who must be able to take the job. " +
      'The partner it is taken from is owed `previous_owed`, else nothing; the new partner is told. A job whose ' +
      'pieces are all past the payout step is a 409: set what each partner is owed instead. Unless the workspace lets ' +
      "one order's lines go to different partners, an order line moves only to the partner holding its other lines (409).",
    body: reassignSchema,
    response: jobAssignmentResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('partner.assign')
  @Post('jobs/:groupId/reassign')
  reassign(
    @CurrentUser() auth: TenantAuth,
    @Param('groupId', idParam) groupId: string,
    @Body(new ZodValidationPipe(reassignSchema)) body: z.infer<typeof reassignSchema>,
  ): Promise<JobAssignmentResponse> {
    return this.jobs.reassign(auth, groupId, body);
  }

  @ApiDoc({
    summary: 'Every time a job was handed to a partner, oldest first.',
    response: jobHistoryResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('partner.read')
  @Get('jobs/:groupId')
  history(@CurrentTenant() tenantId: string, @Param('groupId', idParam) groupId: string): Promise<JobHistoryResponse> {
    return this.jobs.history(tenantId, groupId);
  }

  @ApiDoc({
    summary: 'Set what a partner is owed for a job instead of its cost, with a reason.',
    description:
      'For the partner that has the job, or one it was taken from mid-way (else 404). The job is still owed only once ' +
      'every live piece has passed the payout step; for a partner replaced mid-way, at once.',
    body: setOwedSchema,
    response: owedJobResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('partner.assign')
  @Put('jobs/:groupId/owed')
  setOwed(
    @CurrentUser() auth: TenantAuth,
    @Param('groupId', idParam) groupId: string,
    @Body(new ZodValidationPipe(setOwedSchema)) body: z.infer<typeof setOwedSchema>,
  ): Promise<OwedJobResponse> {
    return this.jobs.setOwed(auth, groupId, body);
  }

  @ApiDoc({
    summary: 'What a partner is owed, per job it has or had, newest first, a page at a time.',
    description:
      "A job is owed once every live piece has passed its workflow's payout step: the cost frozen when it was handed " +
      'over, or what staff set instead. `total` counts only what is owed now, across every page; paying it comes with Payments.',
    query: paginationQuerySchema,
    response: partnerOwedResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('partner.read')
  @Get(':id/owed')
  owed(
    @CurrentTenant() tenantId: string,
    @Param('id', idParam) partnerId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<PartnerOwedResponse> {
    return this.jobs.owed(tenantId, partnerId, query);
  }
}

/** A partner answers the jobs offered to it (Partners spec, goal 10). */
@Controller('partner-portal/partners/:partnerId/jobs/:groupId')
export class PortalJobsController {
  constructor(private readonly jobs: JobsService) {}

  @ApiDoc({
    summary: 'Accept a job offered to the partner, before its deadline.',
    description: 'A job not offered to the partner is a 404; one no longer on offer, or past its deadline, is a 409.',
    response: jobAssignmentResponseSchema,
    errors: [400, 404, 409],
  })
  @PartnerAccess('member')
  @Post('accept')
  @HttpCode(200)
  accept(@CurrentPartner() partner: PartnerAuth, @Param('groupId', idParam) groupId: string): Promise<JobAssignmentResponse> {
    return this.jobs.accept(partner, groupId);
  }

  @ApiDoc({
    summary: 'Decline a job offered to the partner.',
    description: 'Staff are told, and the job needs a partner again. A job not on offer to the partner is a 404 or 409, as for accepting.',
    response: jobAssignmentResponseSchema,
    errors: [400, 404, 409],
  })
  @PartnerAccess('member')
  @Post('decline')
  @HttpCode(200)
  decline(@CurrentPartner() partner: PartnerAuth, @Param('groupId', idParam) groupId: string): Promise<JobAssignmentResponse> {
    return this.jobs.decline(partner, groupId);
  }
}
