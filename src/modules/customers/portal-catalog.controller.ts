import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentCustomer } from '../identity/auth-context';
import type { CustomerAuth } from '../identity/auth-context';
import { CustomerAccess } from '../identity/route-markers';
import { portalProductSchema } from './customer-response';
import type { PortalProduct } from './customer-response';
import { PortalCatalogService } from './portal-catalog.service';

const productsResponseSchema = z.strictObject({ data: z.array(portalProductSchema) });

/** What a customer sees of the catalog (Customers spec, goal 11). */
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
}
