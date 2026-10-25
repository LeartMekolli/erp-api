import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentCustomer } from '../identity/auth-context';
import type { CustomerAuth } from '../identity/auth-context';
import { CustomerAccess } from '../identity/route-markers';
import { PartnerQuotesService } from '../partners/partner-quotes.service';
import { partnerChoicesResponseSchema } from '../partners/partner-response';
import type { PartnerChoicesResponse } from '../partners/partner-response';
import { QUOTE_REFUSAL_CODES, quoteSummaryResponseSchema } from '../pricing/quote-response';
import type { QuoteRefusalCode, QuoteSummaryResponse } from '../pricing/quote-response';
import { QuotesService, customerQuoteRequestSchema } from '../pricing/quotes.service';
import type { CustomerQuoteRequest } from '../pricing/quotes.service';
import { customerRefusal } from './customer-refusals';

const idParam = new ZodValidationPipe(z.uuid());

const portalQuoteRequestSchema = customerQuoteRequestSchema.extend({
  /** A workshop from the customer's choices (`POST .../quotes/partners`): the quote is at its price. */
  partner_id: z.uuid().optional(),
});

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
  constructor(
    private readonly quotes: QuotesService,
    private readonly partnerQuotes: PartnerQuotesService,
  ) {}

  @ApiDoc({
    summary: 'Price a configuration for the customer and save it as a quote.',
    description:
      "The product must be one the customer can see, and `file_version_id` one of the customer's own files; " +
      "anything else is a 404. The customer's group applies. A saved quote is a 201 with the summary; a " +
      'configuration that cannot be priced is a 200 with `accepted: false` and each reason in plain words. ' +
      "With `partner_id`, from the customer's workshop choices, the quote is at that workshop's price and the job " +
      "goes to it when it starts (403 unless the workspace lets the customer pick); a workshop that can't take " +
      'the job is refused with `partner_unavailable`.',
    body: portalQuoteRequestSchema,
    response: portalQuoteResultSchema,
    errors: [400, 404],
  })
  @CustomerAccess('buyer')
  @Post()
  async create(
    @CurrentCustomer() customer: CustomerAuth,
    @Body(new ZodValidationPipe(portalQuoteRequestSchema)) body: z.infer<typeof portalQuoteRequestSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PortalQuoteResult> {
    const { partner_id: partnerId, ...request } = body;
    const result = partnerId
      ? await this.partnerQuotes.quote(customer, request, partnerId)
      : await this.quotes.create(customer, request, { customerId: customer.customerId, audience: 'customer' });
    res.status(result.accepted ? 201 : 200);
    return result.accepted ? result : { accepted: false, reasons: result.reasons.map(customerRefusal) };
  }

  @ApiDoc({
    summary: 'The workshops the customer may pick for a configuration, each at the price the customer would pay with it.',
    description:
      'Only workshops that take direct orders and can take the job right now; nothing is saved. Quote with one by ' +
      "sending its id as `partner_id`. 403 unless the workspace lets the customer pick.",
    body: customerQuoteRequestSchema,
    response: partnerChoicesResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('buyer')
  @Post('partners')
  @HttpCode(200)
  partners(
    @CurrentCustomer() customer: CustomerAuth,
    @Body(new ZodValidationPipe(customerQuoteRequestSchema)) body: CustomerQuoteRequest,
  ): Promise<PartnerChoicesResponse> {
    return this.partnerQuotes.choices(customer, body);
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
