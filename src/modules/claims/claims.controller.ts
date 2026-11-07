import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page, PaginationQuery } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentCustomer, CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { CustomerAuth, TenantAuth } from '../identity/auth-context';
import { CustomerAccess, RequirePermission } from '../identity/route-markers';
import { shipOrderSchema } from '../orders/orders.service';
import type { ShipOrder } from '../orders/orders.service';
import { claimDecisionResponseSchema, claimResponseSchema, customerClaimResponseSchema } from './claim-response';
import type { ClaimDecisionResponse, ClaimResponse, CustomerClaimResponse } from './claim-response';
import { ClaimsService, claimListQuerySchema, decideLineSchema, openClaimSchema, requestReturnSchema } from './claims.service';
import type { ClaimListQuery, DecideLine, OpenClaim, RequestReturn } from './claims.service';

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
    summary: 'Claims, newest first, by order, state, fault, workshop at fault or customer, a page at a time.',
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
    description:
      "A 409 once asked, or when every line is decided. With `label`, a return label from the order's address to " +
      "the courier account's is bought first, for the customer to print; the parcel, carrier and service default to " +
      "the order's shipping method's (400 when it has none). No courier account is a 409; when the courier service " +
      'refuses, a 503 with its reason, and nothing is asked back. Its tracking is shown, but staff still mark the pieces received.',
    body: requestReturnSchema,
    response: claimResponseSchema,
    errors: [400, 404, 409, 503],
  })
  @RequirePermission('order.write')
  @Post('claims/:id/return')
  @HttpCode(200)
  requestReturn(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(requestReturnSchema)) body: RequestReturn,
  ): Promise<ClaimResponse> {
    return this.claims.requestReturn(auth, id, body);
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
    summary: 'Decide one claimed line, once: whose fault, and a remake, a refund or a refusal; the customer is told.',
    description:
      'A line decided already, or a claim waiting for the pieces asked back, is a 409. A refusal gives the customer a ' +
      "reason. A refund needs `payment.refund` and is at most the claimed pieces' share of the line, tax included " +
      "(400). It gives back what was paid, and credits the rest on the order's open invoice at the payment provider, " +
      'so the customer never pays first to be paid back; more than both is a 409. The workshop at fault is the one ' +
      "that made the line (400 for a line made in-house): while its job is not paid out it is owed its cost for the " +
      'claimed pieces less, else the line records the shortfall. A remake starts the claimed pieces again from the ' +
      "line's quote, free for the customer, never for an assembly's line (400). At the workshop's fault it is offered " +
      'to that workshop at cost 0; when it cannot take it, `remake.unassigned_reasons` says why, and staff offer the ' +
      "remake's group as any job: the workshop at fault is then owed the new job's cost less, or the claimed pieces' " +
      'share once the workspace makes it.',
    body: decideLineSchema,
    response: claimDecisionResponseSchema,
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
  ): Promise<ClaimDecisionResponse> {
    return this.claims.decide(auth, id, lineId, body);
  }

  @ApiDoc({
    summary: "Ship the claim's remakes as its own parcel, with the courier and tracking number when given; the customer is told.",
    description:
      'Every remake of the claim must be finished. A claim with nothing made again, or shipped already, is a 409. ' +
      "With `label`, the label is bought first, from the courier account's address to the order's, as when shipping " +
      "an order (400, 409 and 503 alike), and its carrier and tracking are the parcel's. When every remade line is at " +
      "the fault of one workshop, that workshop is owed the label's cost less for its original job; otherwise the " +
      "workspace bears it. The courier's delivered tracking marks the parcel delivered.",
    body: shipOrderSchema,
    response: claimResponseSchema,
    errors: [400, 404, 409, 503],
  })
  @RequirePermission('order.ship')
  @Post('claims/:id/ship')
  @HttpCode(200)
  ship(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(shipOrderSchema)) body: ShipOrder,
  ): Promise<ClaimResponse> {
    return this.claims.ship(auth, id, body);
  }

  @ApiDoc({
    summary: "Mark the claim's parcel delivered, which closes the claim.",
    description: 'A claim not shipped, or delivered already, is a 409.',
    response: claimResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('order.ship')
  @Post('claims/:id/delivered')
  @HttpCode(200)
  delivered(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<ClaimResponse> {
    return this.claims.delivered(auth, id);
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
