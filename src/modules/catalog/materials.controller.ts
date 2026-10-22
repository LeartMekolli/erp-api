import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { materialResponseSchema } from './material-response';
import type { MaterialResponse } from './material-response';
import { MaterialsService, createMaterialSchema, priceOverrideSchema, updateMaterialSchema } from './materials.service';

const idSchema = z.uuid();

/** Materials and their prices (Catalog spec C5, B6, B7, B12). */
@Controller('catalog/materials')
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  @ApiDoc({
    summary: 'Create a material with a manual price, or a feed price plus an add-on.',
    description:
      'A feed material names its `feed_metal` (such as silver), is priced by mass, and needs a `fallback_price` for ' +
      'when no feed price exists yet. A manual material needs `manual_price`. Prices are in `currency`, which ' +
      "defaults to the workspace's. A key already in use is a 409.",
    body: createMaterialSchema,
    response: materialResponseSchema,
    errors: [400],
  })
  @RequirePermission('catalog.write')
  @Post()
  create(
    @CurrentTenant() tenantId: string,
    @Body(new ZodValidationPipe(createMaterialSchema)) body: z.infer<typeof createMaterialSchema>,
  ): Promise<MaterialResponse> {
    return this.materials.create(tenantId, body);
  }

  @ApiDoc({
    summary: 'List materials with their current price, newest first.',
    query: paginationQuerySchema,
    response: pageSchema(materialResponseSchema),
    errors: [400],
  })
  @RequirePermission('catalog.read')
  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: z.infer<typeof paginationQuerySchema>,
  ): Promise<Page<MaterialResponse>> {
    return this.materials.list(tenantId, query);
  }

  @ApiDoc({
    summary: 'A material with its current price and where that price comes from.',
    response: materialResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('catalog.read')
  @Get(':id')
  get(@CurrentTenant() tenantId: string, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<MaterialResponse> {
    return this.materials.get(tenantId, id);
  }

  @ApiDoc({
    summary: 'Change a material. Any field but the key.',
    description: 'The result must still be complete: a feed material keeps its metal and fallback, a manual one its price.',
    body: updateMaterialSchema,
    response: materialResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('catalog.write')
  @Patch(':id')
  update(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateMaterialSchema)) body: z.infer<typeof updateMaterialSchema>,
  ): Promise<MaterialResponse> {
    return this.materials.update(tenantId, id, body);
  }

  @ApiDoc({
    summary: "Override a material's price by hand, until the override is removed.",
    description: "In the material's currency and priced unit. Recorded in the audit log with the old and new price.",
    body: priceOverrideSchema,
    response: materialResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('material.price.override')
  @Put(':id/price-override')
  setOverride(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(priceOverrideSchema)) body: z.infer<typeof priceOverrideSchema>,
  ): Promise<MaterialResponse> {
    return this.materials.setOverride(auth, id, body);
  }

  @ApiDoc({
    summary: 'Remove the manual price override; the material goes back to its own price source.',
    description: 'Removing an override that is not there changes nothing.',
    errors: [400, 404],
  })
  @RequirePermission('material.price.override')
  @Delete(':id/price-override')
  @HttpCode(204)
  async removeOverride(@CurrentUser() auth: TenantAuth, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<void> {
    await this.materials.removeOverride(auth, id);
  }
}
