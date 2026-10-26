import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { shippingMethodResponseSchema, taxRatesResponseSchema } from './order-response';
import type { ShippingMethodResponse, TaxRatesResponse } from './order-response';
import { ShippingMethodsService, createShippingMethodSchema, updateShippingMethodSchema } from './shipping-methods.service';
import { TaxRatesService, taxRatesSchema } from './tax-rates.service';

const idParam = new ZodValidationPipe(z.uuid());

/**
 * What an order needs from the workspace: shipping methods and tax rates (Orders spec, goals 9 and
 * 10). Pricing setup, so the same permissions as delivery speeds.
 */
@Controller('orders')
export class OrderSetupController {
  constructor(
    private readonly methods: ShippingMethodsService,
    private readonly taxRates: TaxRatesService,
  ) {}

  @ApiDoc({
    summary: 'Every shipping method, by key, including those switched off.',
    response: z.strictObject({ data: z.array(shippingMethodResponseSchema) }),
  })
  @RequirePermission('pricing.read')
  @Get('shipping-methods')
  async listMethods(@CurrentTenant() tenantId: string): Promise<{ data: ShippingMethodResponse[] }> {
    return { data: await this.methods.list(tenantId) };
  }

  @ApiDoc({
    summary: 'Add a shipping method with its price per order.',
    description: 'A key already in use is a 409.',
    body: createShippingMethodSchema,
    response: shippingMethodResponseSchema,
    errors: [400, 409],
  })
  @RequirePermission('pricing.write')
  @Post('shipping-methods')
  createMethod(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createShippingMethodSchema)) body: z.infer<typeof createShippingMethodSchema>,
  ): Promise<ShippingMethodResponse> {
    return this.methods.create(auth, body);
  }

  @ApiDoc({
    summary: "Change a shipping method's name or price, or switch it off or on.",
    description: 'A method is never deleted: switched off, it can no longer be chosen, and past orders keep it.',
    body: updateShippingMethodSchema,
    response: shippingMethodResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('pricing.write')
  @Patch('shipping-methods/:id')
  updateMethod(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateShippingMethodSchema)) body: z.infer<typeof updateShippingMethodSchema>,
  ): Promise<ShippingMethodResponse> {
    return this.methods.update(auth, id, body);
  }

  @ApiDoc({
    summary: "The workspace's tax rates: the default first, then by country and region.",
    response: taxRatesResponseSchema,
  })
  @RequirePermission('pricing.read')
  @Get('tax-rates')
  listTaxRates(@CurrentTenant() tenantId: string): Promise<TaxRatesResponse> {
    return this.taxRates.list(tenantId);
  }

  @ApiDoc({
    summary: "Replace the workspace's tax rates as a whole.",
    description:
      'A rate without a country is the default; a region needs a country. Each place, and the default, has one rate. ' +
      "An order's address takes its region's rate, else its country's, else the default, else 0.",
    body: taxRatesSchema,
    response: taxRatesResponseSchema,
    errors: [400],
  })
  @RequirePermission('pricing.write')
  @Put('tax-rates')
  replaceTaxRates(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(taxRatesSchema)) body: z.infer<typeof taxRatesSchema>,
  ): Promise<TaxRatesResponse> {
    return this.taxRates.replace(auth, body);
  }
}
