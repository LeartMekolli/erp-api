import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page, PaginationQuery } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { downloadUrlResponseSchema } from '../files/file-response';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { CommentsService, staffCommentSchema } from './comments.service';
import type { StaffComment } from './comments.service';
import { orderCommentResponseSchema, readersChangedResponseSchema } from './order-response';
import type { OrderCommentResponse } from './order-response';

const idParam = new ZodValidationPipe(z.uuid());

type Link = { url: string; expires_at: string };

/** What staff say on an order and its lines, and what the partners making the lines say back. */
@Controller('orders/:id/comments')
export class OrderCommentsController {
  constructor(private readonly comments: CommentsService) {}

  @ApiDoc({
    summary: "An order's comments, oldest first, a page at a time, with who wrote each and the partner that reads it, if any.",
    query: paginationQuerySchema,
    response: pageSchema(orderCommentResponseSchema),
    errors: [400, 404],
  })
  @RequirePermission('order.read')
  @Get()
  list(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<OrderCommentResponse>> {
    return this.comments.staffList(auth.tenantId, id, query);
  }

  @ApiDoc({
    summary: 'Comment on an order or one of its lines, with files attached.',
    description:
      'Where it is posted decides who reads it. On the order, or on a line no partner has accepted yet, only staff do. On a line ' +
      'a partner has accepted, that partner reads it too, named in `partner`, and it stays that partner\'s when the line changes hands. ' +
      'A `line_id` of another order is a 400. Any uploaded file of the workspace can be attached, at most 10; one not found, or not ' +
      'uploaded yet, is a 404 naming it. Comments cannot be edited or deleted. With `readers`, `staff` or a partner\'s id, saying ' +
      "who staff were told would read it, a comment that would reach anyone else (say a partner accepted the line meanwhile) is not " +
      "saved: the 409 has `code: 'readers_changed'` and the `partner` that would read it now, or null for staff alone.",
    body: staffCommentSchema,
    response: orderCommentResponseSchema,
    errors: [400, 404, { status: 409, schema: readersChangedResponseSchema }],
  })
  @RequirePermission('order.write')
  @Post()
  post(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(staffCommentSchema)) body: StaffComment,
  ): Promise<OrderCommentResponse> {
    return this.comments.staffPost(auth, id, body);
  }

  @ApiDoc({
    summary: "A short-lived download link for a comment's attachment.",
    response: downloadUrlResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('order.read')
  @Get(':commentId/attachments/:fileVersionId/url')
  url(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Param('commentId', idParam) commentId: string,
    @Param('fileVersionId', idParam) fileVersionId: string,
  ): Promise<Link> {
    return this.comments.staffUrl(auth.tenantId, id, commentId, fileVersionId);
  }
}
