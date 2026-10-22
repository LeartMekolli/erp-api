import { Body, Controller, Delete, Get, HttpCode, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { ChainsService, chainSchema, stepEffectsSchema } from './chains.service';
import { categoryChainResponseSchema, productChainResponseSchema, stepEffectsResponseSchema } from './pricing-response';
import type { CategoryChainResponse, ProductChainResponse, StepEffectsResponse } from './pricing-response';

const idSchema = z.uuid();

/** Which steps a product goes through (Pricing spec R4). */
@Controller('pricing')
export class ChainsController {
  constructor(private readonly chains: ChainsService) {}

  @ApiDoc({
    summary: "Set a category's usual chain of steps.",
    description: 'Replaces the whole chain. Steps run in their position order, whatever order they are sent in.',
    body: chainSchema,
    response: categoryChainResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('pricing.write')
  @Put('categories/:id/steps')
  setCategory(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(chainSchema)) body: z.infer<typeof chainSchema>,
  ): Promise<CategoryChainResponse> {
    return this.chains.setCategory(auth, id, body);
  }

  @ApiDoc({ summary: "A category's chain of steps.", response: categoryChainResponseSchema, errors: [400, 404] })
  @RequirePermission('pricing.read')
  @Get('categories/:id/steps')
  getCategory(@CurrentTenant() tenantId: string, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<CategoryChainResponse> {
    return this.chains.getCategory(tenantId, id);
  }

  @ApiDoc({
    summary: "Give a product its own chain of steps instead of its category's.",
    description: 'Replaces the whole chain; an empty list is allowed. `DELETE` returns the product to its category chain.',
    body: chainSchema,
    response: productChainResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('pricing.write')
  @Put('products/:id/steps')
  setProduct(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(chainSchema)) body: z.infer<typeof chainSchema>,
  ): Promise<ProductChainResponse> {
    return this.chains.setProduct(auth, id, body);
  }

  @ApiDoc({
    summary: "A product's chain of steps: its own, or its category's.",
    response: productChainResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('pricing.read')
  @Get('products/:id/steps')
  getProduct(@CurrentTenant() tenantId: string, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<ProductChainResponse> {
    return this.chains.getProduct(tenantId, id);
  }

  @ApiDoc({ summary: "Return a product to its category's chain of steps.", errors: [400, 404] })
  @RequirePermission('pricing.write')
  @Delete('products/:id/steps')
  @HttpCode(204)
  async clearProduct(@CurrentUser() auth: TenantAuth, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<void> {
    await this.chains.clearProduct(auth, id);
  }

  @ApiDoc({
    summary: 'Set which steps choosing an option value adds or removes.',
    description:
      'Replaces both lists. Adding a step already in the chain, or removing one that is not, changes nothing; two ' +
      'chosen values that add and remove the same step make a quote refuse.',
    body: stepEffectsSchema,
    response: stepEffectsResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('pricing.write')
  @Put('option-values/:id/step-effects')
  setEffects(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(stepEffectsSchema)) body: z.infer<typeof stepEffectsSchema>,
  ): Promise<StepEffectsResponse> {
    return this.chains.setEffects(auth, id, body);
  }

  @ApiDoc({ summary: 'The steps choosing an option value adds or removes.', response: stepEffectsResponseSchema, errors: [400, 404] })
  @RequirePermission('pricing.read')
  @Get('option-values/:id/step-effects')
  getEffects(@CurrentTenant() tenantId: string, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<StepEffectsResponse> {
    return this.chains.getEffects(tenantId, id);
  }
}
