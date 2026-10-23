import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { quoteResponseSchema, quoteResultResponseSchema, quoteSummaryResponseSchema } from './quote-response';
import type { QuoteResponse, QuoteResultResponse, QuoteSummaryResponse } from './quote-response';
import { QuotesService, quoteRequestSchema } from './quotes.service';
import type { QuoteRequest } from './quotes.service';

const idSchema = z.uuid();
const idParam = new ZodValidationPipe(idSchema);

/** Saved quotes: the staff breakdown and the customer summary (Pricing spec). */
@Controller('pricing/quotes')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @ApiDoc({
    summary: 'Price a configuration of a product and save it as a quote.',
    description:
      'Runs the configuration check, works out the steps, prices them and applies overhead, margin, the quantity ' +
      'tier, the customer group and the delivery speed. A saved quote is a 201 with the customer summary; its ' +
      "price holds until `expires_at`. A configuration that cannot be priced is a 200 with `accepted: false` and " +
      'every reason, and nothing is saved. An unknown `customer_group` or `delivery_speed` is a 400. ' +
      "With `customer_id`, the quote is for that customer: the customer's group applies (naming `customer_group` as " +
      'well is a 400) and its people see the quote in the portal.',
    body: quoteRequestSchema,
    response: quoteResultResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('quote.create')
  @Post()
  async create(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(quoteRequestSchema)) body: QuoteRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuoteResultResponse> {
    const context = body.customer_id ? { customerId: body.customer_id, audience: 'staff' as const } : undefined;
    const result = await this.quotes.create(auth, body, context);
    res.status(result.accepted ? 201 : 200);
    return result;
  }

  @ApiDoc({
    summary: 'Saved quotes with their staff breakdown, newest first.',
    query: paginationQuerySchema,
    response: pageSchema(quoteResponseSchema),
    errors: [400],
  })
  @RequirePermission('pricing.read')
  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: z.infer<typeof paginationQuerySchema>,
  ): Promise<Page<QuoteResponse>> {
    return this.quotes.list(tenantId, query);
  }

  @ApiDoc({
    summary: 'A saved quote with every number and where it came from.',
    description: 'The amounts never change after saving; `expired` says whether the price still holds.',
    response: quoteResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('pricing.read')
  @Get(':id')
  get(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<QuoteResponse> {
    return this.quotes.get(tenantId, id);
  }

  @ApiDoc({
    summary: "A saved quote as the customer sees it: grouped lines that add up to the price.",
    response: quoteSummaryResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('quote.create')
  @Get(':id/summary')
  summary(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<QuoteSummaryResponse> {
    return this.quotes.summary(tenantId, id);
  }
}
