import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentCustomer } from '../identity/auth-context';
import type { CustomerAuth } from '../identity/auth-context';
import { CustomerAccess } from '../identity/route-markers';
import { QUOTE_REFUSAL_CODES, quoteSummaryResponseSchema } from '../pricing/quote-response';
import type { QuoteRefusalCode, QuoteSummaryResponse } from '../pricing/quote-response';
import { QuotesService, customerQuoteRequestSchema } from '../pricing/quotes.service';
import type { CustomerQuoteRequest } from '../pricing/quotes.service';
import { customerRefusal } from './customer-refusals';

const idParam = new ZodValidationPipe(z.uuid());

/** A saved quote (201), or why it cannot be quoted in plain words (200, nothing saved). */
const portalQuoteResultSchema = z.discriminatedUnion('accepted', [
  z.strictObject({ accepted: z.literal(true), quote: quoteSummaryResponseSchema }),
  z.strictObject({
    accepted: z.literal(false),
    reasons: z.array(z.strictObject({ code: z.enum(QUOTE_REFUSAL_CODES), message: z.string() })),
  }),
]);
type PortalQuoteResult =
  | { accepted: true; quote: QuoteSummaryResponse }
  | { accepted: false; reasons: { code: QuoteRefusalCode; message: string }[] };

/** The customer's own quotes (Customers spec, goals 5 and 8): always the summary, never the breakdown. */
@Controller('portal/customers/:customerId/quotes')
export class PortalQuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @ApiDoc({
    summary: 'Price a configuration for the customer and save it as a quote.',
    description:
      "The product must be one the customer can see, and `file_version_id` one of the customer's own files; " +
      "anything else is a 404. The customer's group applies. A saved quote is a 201 with the summary; a " +
      'configuration that cannot be priced is a 200 with `accepted: false` and each reason in plain words.',
    body: customerQuoteRequestSchema,
    response: portalQuoteResultSchema,
    errors: [400, 404],
  })
  @CustomerAccess('buyer')
  @Post()
  async create(
    @CurrentCustomer() customer: CustomerAuth,
    @Body(new ZodValidationPipe(customerQuoteRequestSchema)) body: CustomerQuoteRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PortalQuoteResult> {
    const result = await this.quotes.create(customer, body, { customerId: customer.customerId, audience: 'customer' });
    res.status(result.accepted ? 201 : 200);
    return result.accepted ? result : { accepted: false, reasons: result.reasons.map(customerRefusal) };
  }

  @ApiDoc({
    summary: "The customer's quotes, newest first.",
    query: paginationQuerySchema,
    response: pageSchema(quoteSummaryResponseSchema),
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get()
  list(
    @CurrentCustomer() customer: CustomerAuth,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: z.infer<typeof paginationQuerySchema>,
  ): Promise<Page<QuoteSummaryResponse>> {
    return this.quotes.customerList(customer.tenantId, customer.customerId, query);
  }

  @ApiDoc({
    summary: "One of the customer's quotes: grouped lines that add up to the price.",
    response: quoteSummaryResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get(':id')
  get(@CurrentCustomer() customer: CustomerAuth, @Param('id', idParam) id: string): Promise<QuoteSummaryResponse> {
    return this.quotes.customerSummary(customer.tenantId, customer.customerId, id);
  }
}
