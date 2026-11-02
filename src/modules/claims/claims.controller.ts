import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page, PaginationQuery } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentCustomer, CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { CustomerAuth, TenantAuth } from '../identity/auth-context';
import { CustomerAccess, RequirePermission } from '../identity/route-markers';
import { claimResponseSchema, customerClaimResponseSchema } from './claim-response';
import type { ClaimResponse, CustomerClaimResponse } from './claim-response';
import { ClaimsService, claimListQuerySchema, decideLineSchema, openClaimSchema } from './claims.service';
import type { ClaimListQuery, DecideLine, OpenClaim } from './claims.service';

const idParam = new ZodValidationPipe(z.uuid());

const OPEN_DESCRIPTION =
  'Only on a delivered order, within `orders.claims.windowDays` of delivery (30 unless set), else a 409. The reason is ' +
  'a key of `orders.claims.reasons`; each line is named by its position, never a cancelled one, with no more pieces ' +
  'than are left to claim on it (400). Photos are uploaded file versions: the customer attaches only its own (404 ' +
  'naming the photo). Staff who read orders are told.';

/** Claims as staff follow and handle them (Orders 3 spec, goals 1, 2 and 7). */
@Controller()
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @ApiDoc({
    summary: 'Open a claim on a delivered order for some pieces of some of its lines.',
    description: OPEN_DESCRIPTION,
    body: openClaimSchema,
    response: claimResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('order.write')
  @Post('orders/:id/claims')
  open(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) orderId: string,
    @Body(new ZodValidationPipe(openClaimSchema)) body: OpenClaim,
  ): Promise<ClaimResponse> {
    return this.claims.staffOpen(auth, orderId, body);
  }

  @ApiDoc({
    summary: 'Claims, newest first, by state, fault, workshop at fault or customer, a page at a time.',
    query: claimListQuerySchema,
    response: pageSchema(claimResponseSchema),
    errors: [400],
  })
  @RequirePermission('order.read')
  @Get('claims')
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(claimListQuerySchema)) query: ClaimListQuery,
  ): Promise<Page<ClaimResponse>> {
    return this.claims.list(tenantId, query);
  }

  @ApiDoc({
    summary: 'One claim, with each line and its decision.',
    response: claimResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('order.read')
  @Get('claims/:id')
  get(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<ClaimResponse> {
    return this.claims.get(tenantId, id);
  }

  @ApiDoc({
    summary: 'Ask for the claimed pieces back: the claim waits for them before its lines are decided.',
    description: 'A 409 once asked, or when every line is decided.',
    response: claimResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('order.write')
  @Post('claims/:id/return')
  @HttpCode(200)
  requestReturn(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<ClaimResponse> {
    return this.claims.requestReturn(auth, id);
  }

  @ApiDoc({
    summary: 'Mark the pieces asked back as received, so the claim can be decided.',
    description: 'A 409 when they were not asked back, or were received already.',
    response: claimResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('order.write')
  @Post('claims/:id/returned')
  @HttpCode(200)
  markReturned(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<ClaimResponse> {
    return this.claims.markReturned(auth, id);
  }

  @ApiDoc({
    summary: 'Decide one claimed line, once: whose fault, and a refund or a refusal; the customer is told.',
    description:
      'A line decided already, or a claim waiting for the pieces asked back, is a 409. A refusal gives the customer a ' +
      "reason. A refund needs `payment.refund` and is at most the claimed pieces' share of the line, tax included " +
      '(400); it gives back what was paid, and more than is left to refund is a 409. The workshop at fault is the one ' +
      "that made the line (400 for a line made in-house): while its job is not paid out it is owed its cost for the " +
      'claimed pieces less, else the line records the shortfall.',
    body: decideLineSchema,
    response: claimResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('order.write')
  @Post('claims/:id/lines/:lineId/decision')
  @HttpCode(200)
  decide(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Param('lineId', idParam) lineId: string,
    @Body(new ZodValidationPipe(decideLineSchema)) body: DecideLine,
  ): Promise<ClaimResponse> {
    return this.claims.decide(auth, id, lineId, body);
  }
}

/** The customer's own claims: never whose fault staff found, nor their note. */
@Controller('portal/customers/:customerId')
export class PortalClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @ApiDoc({
    summary: "Claim some pieces of the customer's delivered order: faulty, damaged or wrong.",
    description: OPEN_DESCRIPTION,
    body: openClaimSchema,
    response: customerClaimResponseSchema,
    errors: [400, 404, 409],
  })
  @CustomerAccess('buyer')
  @Post('orders/:orderId/claims')
  open(
    @CurrentCustomer() customer: CustomerAuth,
    @Param('orderId', idParam) orderId: string,
    @Body(new ZodValidationPipe(openClaimSchema)) body: OpenClaim,
  ): Promise<CustomerClaimResponse> {
    return this.claims.customerOpen(customer, orderId, body);
  }

  @ApiDoc({
    summary: "The customer's claims, newest first, a page at a time.",
    query: paginationQuerySchema,
    response: pageSchema(customerClaimResponseSchema),
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get('claims')
  list(
    @CurrentCustomer() customer: CustomerAuth,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<CustomerClaimResponse>> {
    return this.claims.customerList(customer, query);
  }

  @ApiDoc({
    summary: "One of the customer's claims, with each line's decision and the reason given.",
    response: customerClaimResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get('claims/:id')
  get(@CurrentCustomer() customer: CustomerAuth, @Param('id', idParam) id: string): Promise<CustomerClaimResponse> {
    return this.claims.customerGet(customer, id);
  }
}
