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
import { rangeQuerySchema } from '../reporting/range-buckets';
import type { RangeQuery } from '../reporting/range-buckets';
import { MovesService, moveSchema } from '../workflow/moves.service';
import type { MoveBody } from '../workflow/moves.service';
import { moveResponseSchema } from '../workflow/work-order-response';
import type { MoveResponse } from '../workflow/work-order-response';
import { JobsService } from './jobs.service';
import { partnerJobsCountsQuerySchema, partnerJobsQuerySchema } from './partner-jobs-query';
import type { PartnerJobsCountsQuery, PartnerJobsQuery } from './partner-jobs-query';
import { PartnerJobsService } from './partner-jobs.service';
import { partnerSummaryResponseSchema } from './partner-summary-response';
import type { PartnerSummaryResponse } from './partner-summary-response';
import { PartnerSummaryService } from './partner-summary.service';
import {
  partnerJobCountsResponseSchema,
  partnerJobDetailResponseSchema,
  partnerJobsResponseSchema,
  partnerWorkOrderResponseSchema,
  portalOwedResponseSchema,
} from './partner-response';
import type {
  PartnerJobCountsResponse,
  PartnerJobDetailResponse,
  PartnerJobResponse,
  PartnerWorkOrderResponse,
  PortalOwedResponse,
} from './partner-response';

const idParam = new ZodValidationPipe(z.uuid());

/** A partner at work: its jobs, what to make, and moving its pieces (Partners spec, goal 13). */
@Controller('partner-portal/partners/:partnerId')
export class PartnerJobsController {
  constructor(
    private readonly jobs: PartnerJobsService,
    private readonly moves: MovesService,
    private readonly assignments: JobsService,
    private readonly summaries: PartnerSummaryService,
  ) {}

  @ApiDoc({
    summary: "The partner's jobs finished and pieces at its steps for any dates; earnings per bucket for admins and owners.",
    description:
      'Dates are in the workspace time zone, both ends included. `pending` is money in a payout that has not been paid yet; ' +
      'a failed or reversed payout counts as owed again. `earned`, `previous_earned`, `paid_total`, `pending_total`, ' +
      '`owed_total`, `currency` and `series` are left out for a member.',
    query: rangeQuerySchema,
    response: partnerSummaryResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get('summary')
  summary(
    @CurrentPartner() partner: PartnerAuth,
    @Query(new ZodValidationPipe(rangeQuerySchema)) query: RangeQuery,
  ): Promise<PartnerSummaryResponse> {
    return this.summaries.summary(partner, query);
  }

  @ApiDoc({
    summary: 'What the partner is owed, per job it has or had, newest first, a page at a time.',
    description:
      'A job is owed once every live piece has passed the payout step: its cost, or an amount the workspace set. ' +
      '`due_total` is what the next payout pays and `not_yet_total` what the jobs not owed yet will be, across every page. ' +
      "A job's `paid` includes what payouts still pending hold; the summary shows those apart as `pending`.",
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
    const { jobs, ...totals } = await this.assignments.owed(partner.tenantId, partner.partnerId, query);
    // Staff's reasons stay with staff.
    return {
      ...totals,
      jobs: jobs.map((job) => ({
        assignment_id: job.assignment_id,
        group_id: job.group_id,
        product: job.product,
        quantity: job.quantity,
        state: job.state,
        holding: job.holding,
        amount: job.amount,
        paid: job.paid,
        due: job.due,
      })),
    };
  }

  @ApiDoc({
    summary: 'The jobs offered to or accepted by the partner, a page at a time.',
    description:
      'Never the customer, the quote or the price the customer pays. `status`, `due` and `q` filter before paging, ' +
      "combined with AND. `due` picks jobs the partner is working on (`accepted`): `late` is past its due date, `due_soon` " +
      "due from the workspace's today to 2 working days on, in the workspace's time zone and on its calendar; an offer or a " +
      'finished job is neither. `q` matches part of the product name or of a chosen option value. `sort` is newest hand-over ' +
      'first by default; jobs with no due date come last in both `due_on` sorts, and a cursor works only with the sort it was ' +
      "made for. Each step's `count` is the job's active pieces at it now.",
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
    summary: "How many of the partner's jobs each tab and tile holds.",
    description:
      'Decided as the list decides `status` and `due`, for the same `q`, so a number always matches the list it opens. ' +
      'Only `q` is taken; anything else is a 400.',
    query: partnerJobsCountsQuerySchema,
    response: partnerJobCountsResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  // Before `jobs/:groupId`, which would read `counts` as an id.
  @Get('jobs/counts')
  counts(
    @CurrentPartner() partner: PartnerAuth,
    @Query(new ZodValidationPipe(partnerJobsCountsQuerySchema)) query: PartnerJobsCountsQuery,
  ): Promise<PartnerJobCountsResponse> {
    return this.jobs.counts(partner, query);
  }

  @ApiDoc({
    summary: "One of the partner's jobs, with its steps' QC rules and each of its pieces.",
    description:
      "Each of the partner's steps says what a pass or fail there needs; a step the workspace does is only named, as a rework target. " +
      '`to_inspect` says which pieces at a sampling step must be inspected.',
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
    summary: "One piece of the partner's job, with every move it has had, oldest first.",
    description:
      "Only for a job the partner has accepted and still holds, and a piece of it; else a 404. Names and what was written show only on moves the partner's own people made.",
    response: partnerWorkOrderResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get('jobs/:groupId/work-orders/:workOrderId')
  workOrder(
    @CurrentPartner() partner: PartnerAuth,
    @Param('groupId', idParam) groupId: string,
    @Param('workOrderId', idParam) workOrderId: string,
  ): Promise<PartnerWorkOrderResponse> {
    return this.jobs.workOrder(partner, groupId, workOrderId);
  }

  @ApiDoc({
    summary: "A short-lived download link for one of the partner's steps' instructions.",
    description:
      'Only for a job the partner has accepted and a step it does on that job; otherwise, or when the step has no instructions, a 404.',
    response: downloadUrlResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get('jobs/:groupId/steps/:stepKey/sop')
  sop(
    @CurrentPartner() partner: PartnerAuth,
    @Param('groupId', idParam) groupId: string,
    @Param('stepKey') stepKey: string,
  ): Promise<{ url: string; expires_at: string }> {
    return this.jobs.sop(partner, groupId, stepKey);
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
