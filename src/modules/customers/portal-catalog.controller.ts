import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentCustomer } from '../identity/auth-context';
import type { CustomerAuth } from '../identity/auth-context';
import { CustomerAccess } from '../identity/route-markers';
import { portalProductSchema } from './customer-response';
import type { PortalProduct } from './customer-response';
import { PortalCatalogService } from './portal-catalog.service';

const productsResponseSchema = z.strictObject({ data: z.array(portalProductSchema) });

const saveQuoteSchema = z.object({
  /** One of the customer's quotes, for a shared custom product, made with a design file. */
  quote_id: z.uuid(),
  name: z.string().trim().min(1).max(200),
});

/** What a customer sees of the catalog, and the products it saves from its quotes (Customers spec, goals 7 and 11). */
@Controller('portal/customers/:customerId/products')
export class PortalCatalogController {
  constructor(private readonly catalog: PortalCatalogService) {}

  @ApiDoc({
    summary: "The products the customer can order: the published catalog and the customer's own products, by name.",
    description: 'Options and values are described by key and name; prices come only with a quote.',
    response: productsResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get()
  list(@CurrentCustomer() customer: CustomerAuth): Promise<{ data: PortalProduct[] }> {
    return this.catalog.list(customer);
  }

  @ApiDoc({
    summary: "Save one of the customer's quotes as the customer's own product.",
    description:
      'The product keeps the configuration (options, sizing, the design file), not the price: every new quote ' +
      "for it uses current prices. Only a quote for a shared custom product, made with a design file, can be saved (400); another customer's quote is a 404.",
    body: saveQuoteSchema,
    response: portalProductSchema,
    errors: [400, 404, 409],
  })
  @CustomerAccess('buyer')
  @Post()
  save(
    @CurrentCustomer() customer: CustomerAuth,
    @Body(new ZodValidationPipe(saveQuoteSchema)) body: z.infer<typeof saveQuoteSchema>,
  ): Promise<PortalProduct> {
    return this.catalog.saveQuote(customer, { quoteId: body.quote_id, name: body.name });
  }
}
