import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination/page';
import type { PaginationQuery } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentCustomer, CurrentPartner, CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { CustomerAuth, PartnerAuth, TenantAuth } from '../identity/auth-context';
import { CustomerAccess, PartnerAccess, RequirePermission } from '../identity/route-markers';
import {
  customerRatingResponseSchema,
  partnerRatingsResponseSchema,
  partnerScoreResponseSchema,
  ratingResponseSchema,
} from './partner-response';
import type { CustomerRatingResponse, PartnerRatingsResponse, PartnerScoreResponse, RatingResponse } from './partner-response';
import { RatingsService, rateSchema } from './ratings.service';

const idParam = new ZodValidationPipe(z.uuid());

/** A customer rates a finished job (Partners spec, goal 16). */
@Controller('portal/customers/:customerId/jobs/:groupId')
export class PortalRatingsController {
  constructor(private readonly ratings: RatingsService) {}

  @ApiDoc({
    summary: "Rate one of the customer's finished jobs, once: 1 to 5 stars and an optional comment.",
    description:
      'The workshop that made it sees the stars; staff decide whether it may read the comment, and it never sees who ' +
      'wrote it. A job not yet finished, made in-house, or already rated is a 409.',
    body: rateSchema,
    response: customerRatingResponseSchema,
    errors: [400, 404, 409],
  })
  @CustomerAccess('buyer')
  @Post('rating')
  rate(
    @CurrentCustomer() customer: CustomerAuth,
    @Param('groupId', idParam) groupId: string,
    @Body(new ZodValidationPipe(rateSchema)) body: z.infer<typeof rateSchema>,
  ): Promise<CustomerRatingResponse> {
    return this.ratings.rate(customer, groupId, body);
  }
}

/** Staff see every rating and choose which comments a partner may read (P15). */
@Controller('partners')
export class RatingsController {
  constructor(private readonly ratings: RatingsService) {}

  @ApiDoc({
    summary: "A partner's ratings, newest first, a page at a time, with the customer and every comment.",
    query: paginationQuerySchema,
    response: partnerRatingsResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('partner.read')
  @Get(':id/ratings')
  list(
    @CurrentTenant() tenantId: string,
    @Param('id', idParam) partnerId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<PartnerRatingsResponse> {
    return this.ratings.list(tenantId, partnerId, query);
  }

  @ApiDoc({
    summary: "Let the partner read a rating's comment, without anything naming the customer.",
    response: ratingResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('partner.write')
  @Post('ratings/:id/share')
  @HttpCode(200)
  share(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<RatingResponse> {
    return this.ratings.share(auth, id);
  }
}

/** A partner's own score (Partners spec, goal 15). */
@Controller('partner-portal/partners/:partnerId')
export class PartnerScoreController {
  constructor(private readonly ratings: RatingsService) {}

  @ApiDoc({
    summary: "The partner's score, its parts, and its customers' 50 newest ratings.",
    description: 'A comment shows only once staff share it, and nothing ever names the customer.',
    response: partnerScoreResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get('score')
  score(@CurrentPartner() partner: PartnerAuth): Promise<PartnerScoreResponse> {
    return this.ratings.mine(partner);
  }
}
