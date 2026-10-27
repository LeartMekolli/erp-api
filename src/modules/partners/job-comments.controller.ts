import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page, PaginationQuery } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { downloadUrlResponseSchema } from '../files/file-response';
import { CurrentPartner } from '../identity/auth-context';
import type { PartnerAuth } from '../identity/auth-context';
import { PartnerAccess } from '../identity/route-markers';
import { CommentsService, partnerCommentSchema } from '../orders/comments.service';
import type { PartnerComment } from '../orders/comments.service';
import { partnerJobCommentResponseSchema } from './partner-response';
import type { PartnerJobCommentResponse } from './partner-response';

const idParam = new ZodValidationPipe(z.uuid());

/**
 * A partner's talk with the workspace about a job it holds (Orders spec, goal 13): only what staff marked for
 * it and what it wrote itself. Never the customer, the order, another line or a comment not sent to it.
 */
@Controller('partner-portal/partners/:partnerId/jobs/:groupId/comments')
export class JobCommentsController {
  constructor(private readonly comments: CommentsService) {}

  @ApiDoc({
    summary: "The comments on one of the partner's jobs, oldest first, a page at a time.",
    description: 'Only for a job the partner has accepted and still holds; else a 404.',
    query: paginationQuerySchema,
    response: pageSchema(partnerJobCommentResponseSchema),
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get()
  list(
    @CurrentPartner() partner: PartnerAuth,
    @Param('groupId', idParam) groupId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<PartnerJobCommentResponse>> {
    return this.comments.partnerList(partner, groupId, query);
  }

  @ApiDoc({
    summary: 'Comment on a job the partner holds, in text.',
    description: 'Only the workspace reads it. For a job the partner does not hold, a 404.',
    body: partnerCommentSchema,
    response: partnerJobCommentResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Post()
  post(
    @CurrentPartner() partner: PartnerAuth,
    @Param('groupId', idParam) groupId: string,
    @Body(new ZodValidationPipe(partnerCommentSchema)) body: PartnerComment,
  ): Promise<PartnerJobCommentResponse> {
    return this.comments.partnerPost(partner, groupId, body);
  }

  @ApiDoc({
    summary: "A short-lived download link for an attachment of a comment sent to the partner.",
    response: downloadUrlResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get(':commentId/attachments/:fileVersionId/url')
  url(
    @CurrentPartner() partner: PartnerAuth,
    @Param('groupId', idParam) groupId: string,
    @Param('commentId', idParam) commentId: string,
    @Param('fileVersionId', idParam) fileVersionId: string,
  ): Promise<{ url: string; expires_at: string }> {
    return this.comments.partnerUrl(partner, groupId, commentId, fileVersionId);
  }
}
