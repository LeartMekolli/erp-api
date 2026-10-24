import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
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
import { PartnerJobsService, partnerJobsQuerySchema } from './partner-jobs.service';
import { partnerJobDetailResponseSchema, partnerJobsResponseSchema } from './partner-response';
import type { PartnerJobDetailResponse, PartnerJobResponse } from './partner-response';

const idParam = new ZodValidationPipe(z.uuid());

/** A partner at work: its jobs, what to make, and moving its pieces (Partners spec, goal 13). */
@Controller('partner-portal/partners/:partnerId')
export class PartnerJobsController {
  constructor(
    private readonly jobs: PartnerJobsService,
    private readonly moves: MovesService,
  ) {}

  @ApiDoc({
    summary: 'The jobs offered to or accepted by the partner, newest first.',
    description: 'Never the customer, the quote or the price the customer pays.',
    query: partnerJobsQuerySchema,
    response: partnerJobsResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get('jobs')
  list(
    @CurrentPartner() partner: PartnerAuth,
    @Query(new ZodValidationPipe(partnerJobsQuerySchema)) query: z.infer<typeof partnerJobsQuerySchema>,
  ): Promise<{ data: PartnerJobResponse[] }> {
    return this.jobs.list(partner, query.status);
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
    response: downloadUrlResponseSchema,
    errors: [400, 404, 409],
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
      "at steps the partner does (else 409, naming each piece). Each move counts for the partner's score.",
    body: moveSchema,
    response: moveResponseSchema,
    errors: [400, 404, 409],
  })
  @PartnerAccess('member')
  @Post('moves')
  @HttpCode(200)
  move(@CurrentPartner() partner: PartnerAuth, @Body(new ZodValidationPipe(moveSchema)) body: MoveBody): Promise<MoveResponse> {
    return this.moves.move(partner, body, { partnerId: partner.partnerId });
  }
}
