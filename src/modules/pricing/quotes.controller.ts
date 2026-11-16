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
import { AdjustmentsService } from './adjustments.service';
import { speedChoicesResponseSchema } from './pricing-response';
import type { SpeedChoicesResponse } from './pricing-response';
import { quoteResponseSchema, quoteResultResponseSchema, quoteSummaryResponseSchema } from './quote-response';
import type { QuoteResponse, QuoteResultResponse, QuoteSummaryResponse } from './quote-response';
import { QuotesService, quoteRequestSchema } from './quotes.service';
import type { QuoteRequest } from './quotes.service';

const idSchema = z.uuid();
const idParam = new ZodValidationPipe(idSchema);
/** With a customer, only the speeds its plan offers. */
const deliverySpeedsQuerySchema = z.object({ customer_id: z.uuid().optional() });

/** Saved quotes: the staff breakdown and the customer summary (Pricing spec). */
@Controller('pricing/quotes')
export class QuotesController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly adjustments: AdjustmentsService,
  ) {}

  @ApiDoc({
    summary: 'Price a configuration of a product and save it as a quote.',
    description:
      'Runs the configuration check, works out the steps, prices them and applies overhead, margin, the quantity ' +
      'tier, the customer group and the delivery speed. A saved quote is a 201 with the customer summary; its ' +
      "price holds until `expires_at`. A configuration that cannot be priced is a 200 with `accepted: false` and " +
      'every reason, and nothing is saved. An unknown `customer_group` or `delivery_speed` is a 400. ' +
      "With `customer_id`, the quote is for that customer: the customer's group applies (naming `customer_group` as " +
      'well is a 400) and its people see the quote in the portal. ' +
      'With `customer_id`, the product must be one that customer can see and `file_version_id` one of its own files; ' +
      "without it, the file must not be a customer's. Anything else is a 404. A product made of parts is priced as its own " +
      "steps plus a quote per part, at the options it shares with the part, the part's size and the quantity the " +
      "line needs; any part that can't be priced refuses it, naming the part. `GET` shows the parts under `breakdown.parts`. " +
      "`partner_id` (with `customer_id`) quotes with that workshop's prices, as the customer's own pick would: 403 unless the " +
      "workspace lets the customer pick, and a workshop that can't take the job is refused with `partner_unavailable`.",
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
    const { partner_id: partnerId, ...request } = body;
    const context = body.customer_id ? { customerId: body.customer_id, audience: 'staff' as const } : undefined;
    // The schema ties `partner_id` to `customer_id`, so a pick always has a customer.
    const partner =
      partnerId && body.customer_id ? await this.quotes.partnerPick(auth.tenantId, body.customer_id, partnerId) : undefined;
    const result = await this.quotes.create(auth, request, context, partner);
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
    summary: 'The delivery speeds a quote can name, by key.',
    description:
      "Without surcharges: whoever quotes needs the names and the days, the prices come with a quote. With `customer_id`, only the speeds the customer's plan offers.",
    query: deliverySpeedsQuerySchema,
    response: speedChoicesResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('quote.create')
  @Get('delivery-speeds')
  async deliverySpeeds(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(deliverySpeedsQuerySchema)) query: z.infer<typeof deliverySpeedsQuerySchema>,
  ): Promise<SpeedChoicesResponse> {
    return { data: await this.adjustments.speedChoices(tenantId, query.customer_id) };
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
