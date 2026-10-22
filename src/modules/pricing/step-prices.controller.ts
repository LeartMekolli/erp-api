import { Body, Controller, Delete, Get, HttpCode, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { stepPriceResponseSchema } from './pricing-response';
import type { StepPriceResponse } from './pricing-response';
import { StepPricesService, stepPriceSchema } from './step-prices.service';

const idSchema = z.uuid();

/** What each step costs, from typed building blocks (Pricing spec). */
@Controller('pricing')
export class StepPricesController {
  constructor(private readonly prices: StepPricesService) {}

  @ApiDoc({
    summary: "Set a step's price, for one material or as the step's default.",
    description:
      'Creates or replaces the price for the step and `material_id` (omitted: the default, used for every other ' +
      'material). The cost is built only from the typed blocks; amounts are per piece, `setup` per run and `batch` ' +
      'per batch. A unit that does not fit its measure, or a named material that cannot be charged as the block ' +
      'says (such as by weight without a density), is a 400.',
    body: stepPriceSchema,
    response: stepPriceResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('pricing.write')
  @Put('step-types/:id/prices')
  put(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(stepPriceSchema)) body: z.infer<typeof stepPriceSchema>,
  ): Promise<StepPriceResponse> {
    return this.prices.put(auth, id, body);
  }

  @ApiDoc({
    summary: "A step's prices: its default first, then each material's own.",
    response: z.strictObject({ data: z.array(stepPriceResponseSchema) }),
    errors: [400, 404],
  })
  @RequirePermission('pricing.read')
  @Get('step-types/:id/prices')
  async list(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ): Promise<{ data: StepPriceResponse[] }> {
    return { data: await this.prices.list(tenantId, id) };
  }

  @ApiDoc({ summary: 'Delete a step price.', errors: [400, 404] })
  @RequirePermission('pricing.write')
  @Delete('step-prices/:id')
  @HttpCode(204)
  async remove(@CurrentUser() auth: TenantAuth, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<void> {
    await this.prices.remove(auth, id);
  }
}
