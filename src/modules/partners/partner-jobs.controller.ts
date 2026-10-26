import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination/page';
import type { Page, PaginationQuery } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { downloadUrlResponseSchema } from '../files/file-response';
import { CurrentPartner } from '../identity/auth-context';
import type { PartnerAuth } from '../identity/auth-context';
import { PartnerAccess } from '../identity/route-markers';
import { MovesService, moveSchema } from '../workflow/moves.service';
import type { MoveBody } from '../workflow/moves.service';
import { moveResponseSchema } from '../workflow/work-order-response';
import type { MoveResponse } from '../workflow/work-order-response';
import { JobsService } from './jobs.service';
import { PartnerJobsService, partnerJobsQuerySchema } from './partner-jobs.service';
import type { PartnerJobsQuery } from './partner-jobs.service';
import { partnerJobDetailResponseSchema, partnerJobsResponseSchema, portalOwedResponseSchema } from './partner-response';
import type { PartnerJobDetailResponse, PartnerJobResponse, PortalOwedResponse } from './partner-response';

const idParam = new ZodValidationPipe(z.uuid());

/** A partner at work: its jobs, what to make, and moving its pieces (Partners spec, goal 13). */
@Controller('partner-portal/partners/:partnerId')
export class PartnerJobsController {
  constructor(
    private readonly jobs: PartnerJobsService,
    private readonly moves: MovesService,
    private readonly assignments: JobsService,
  ) {}

  @ApiDoc({
    summary: 'What the partner is owed, per job it has or had, newest first, a page at a time.',
    description:
      'A job is owed once every live piece has passed the payout step: its cost, or an amount the workspace set. ' +
      '`total` counts only what is owed now, across every page.',
    query: paginationQuerySchema,
    response: portalOwedResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('admin')
  @Get('owed')
  async owed(
    @CurrentPartner() partner: PartnerAuth,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<PortalOwedResponse> {
    const { total, jobs, next_cursor } = await this.assignments.owed(partner.tenantId, partner.partnerId, query);
    // Staff's reasons stay with staff.
    return {
      total,
      next_cursor,
      jobs: jobs.map((job) => ({
        assignment_id: job.assignment_id,
        group_id: job.group_id,
        product: job.product,
        quantity: job.quantity,
        state: job.state,
        amount: job.amount,
      })),
    };
  }

  @ApiDoc({
    summary: 'The jobs offered to or accepted by the partner, newest first, a page at a time.',
    description: 'Never the customer, the quote or the price the customer pays. `status` filters before paging.',
    query: partnerJobsQuerySchema,
    response: partnerJobsResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get('jobs')
  list(
    @CurrentPartner() partner: PartnerAuth,
    @Query(new ZodValidationPipe(partnerJobsQuerySchema)) query: PartnerJobsQuery,
  ): Promise<Page<PartnerJobResponse>> {
    return this.jobs.list(partner, query);
  }

  @ApiDoc({
    summary: "One of the partner's jobs, with each of its pieces and the step it is at.",
    response: partnerJobDetailResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get('jobs/:groupId')
  detail(@CurrentPartner() partner: PartnerAuth, @Param('groupId', idParam) groupId: string): Promise<PartnerJobDetailResponse> {
    return this.jobs.detail(partner, groupId);
  }

  @ApiDoc({
    summary: "A short-lived download link for the job's design file.",
    description: 'Only once the partner has accepted the job; while it is only offered, a 404.',
    response: downloadUrlResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get('jobs/:groupId/design')
  design(@CurrentPartner() partner: PartnerAuth, @Param('groupId', idParam) groupId: string): Promise<{ url: string; expires_at: string }> {
    return this.jobs.design(partner, groupId);
  }

  @ApiDoc({
    summary: "Move the partner's pieces at its own steps, behind the same QC gate as staff.",
    description:
      'The same body and rules as `POST /workflow/moves`, for pieces of jobs the partner has accepted (else 404), ' +
      "at steps the partner does (else 409, naming each piece). Each move counts for the partner's score. " +
      'A suspended partner can still move the pieces of jobs it holds, so it can finish them.',
    body: moveSchema,
    response: moveResponseSchema,
    errors: [400, 404, 409],
  })
  @PartnerAccess('member', { whileSuspended: true })
  @Post('moves')
  @HttpCode(200)
  move(@CurrentPartner() partner: PartnerAuth, @Body(new ZodValidationPipe(moveSchema)) body: MoveBody): Promise<MoveResponse> {
    return this.moves.move(partner, body, { partnerId: partner.partnerId });
  }
}
