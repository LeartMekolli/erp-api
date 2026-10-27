import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page, PaginationQuery } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { downloadUrlResponseSchema } from '../files/file-response';
import { CurrentCustomer, CurrentUser } from '../identity/auth-context';
import type { CustomerAuth, TenantAuth } from '../identity/auth-context';
import { CustomerAccess, RequirePermission } from '../identity/route-markers';
import { CommentsService, customerCommentSchema, staffCommentSchema } from './comments.service';
import type { CustomerComment, StaffComment } from './comments.service';
import { customerOrderCommentResponseSchema, orderCommentResponseSchema } from './order-response';
import type { CustomerOrderCommentResponse, OrderCommentResponse } from './order-response';

const idParam = new ZodValidationPipe(z.uuid());

type Link = { url: string; expires_at: string };

/** What staff and the customer's people say on an order (Orders spec, goal 13). */
@Controller('orders/:id/comments')
export class OrderCommentsController {
  constructor(private readonly comments: CommentsService) {}

  @ApiDoc({
    summary: "An order's comments, oldest first, a page at a time, with who wrote each and whether the partner reads it.",
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
      "The customer reads it, unless `for_partner` sends it to the partner holding the line instead: that needs a `line_id`, and the " +
      "customer never sees it. A `line_id` of another order is a 400. Any uploaded file of the workspace can be attached, " +
      'at most 10; one not found, or not uploaded yet, is a 404 naming it. Comments cannot be edited or deleted.',
    body: staffCommentSchema,
    response: orderCommentResponseSchema,
    errors: [400, 404],
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

/** The customer's side of an order's comments: never a partner's, and none sent to a partner. */
@Controller('portal/customers/:customerId/orders/:id/comments')
export class PortalOrderCommentsController {
  constructor(private readonly comments: CommentsService) {}

  @ApiDoc({
    summary: "An order's comments for the customer, oldest first, a page at a time: its own people's and what staff wrote for it.",
    query: paginationQuerySchema,
    response: pageSchema(customerOrderCommentResponseSchema),
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get()
  list(
    @CurrentCustomer() customer: CustomerAuth,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<CustomerOrderCommentResponse>> {
    return this.comments.customerList(customer, id, query);
  }

  @ApiDoc({
    summary: 'Comment on an order or one of its lines, with files attached.',
    description:
      'A `line_id` of another order is a 400. Only files the customer uploaded itself can be attached, at most 10; ' +
      'another file, or one not uploaded yet, is a 404 naming it.',
    body: customerCommentSchema,
    response: customerOrderCommentResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('buyer')
  @Post()
  post(
    @CurrentCustomer() customer: CustomerAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(customerCommentSchema)) body: CustomerComment,
  ): Promise<CustomerOrderCommentResponse> {
    return this.comments.customerPost(customer, id, body);
  }

  @ApiDoc({
    summary: "A short-lived download link for an attachment of a comment the customer can read.",
    response: downloadUrlResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get(':commentId/attachments/:fileVersionId/url')
  url(
    @CurrentCustomer() customer: CustomerAuth,
    @Param('id', idParam) id: string,
    @Param('commentId', idParam) commentId: string,
    @Param('fileVersionId', idParam) fileVersionId: string,
  ): Promise<Link> {
    return this.comments.customerUrl(customer, id, commentId, fileVersionId);
  }
}
