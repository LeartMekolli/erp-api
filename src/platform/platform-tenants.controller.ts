import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../common/pagination/page';
import type { Page } from '../common/pagination/page';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { ApiDoc } from '../docs/api-doc';
import { CurrentPlatformAdmin } from '../modules/identity/auth-context';
import type { PlatformAuth } from '../modules/identity/auth-context';
import { RequirePermission } from '../modules/identity/route-markers';
import { createTenantSchema } from './tenant-input';
import { TenantService, tenantResponseSchema } from './tenant.service';
import type { TenantResponse } from './tenant.service';

const listSchema = paginationQuerySchema.extend({
  status: z.enum(['active', 'suspended']).optional(),
});

const idSchema = z.uuid();

@Controller('platform/tenants')
export class PlatformTenantsController {
  constructor(private readonly tenants: TenantService) {}

  @ApiDoc({
    summary: 'Create a tenant and invite its owner by email.',
    description: 'Answers the new tenant `id` and `slug`. A taken slug is a 409.',
    body: createTenantSchema,
    errors: [400, 401, 403, 409],
  })
  @RequirePermission('platform.tenant.create')
  @Post()
  async create(
    @Body(new ZodValidationPipe(createTenantSchema)) body: z.infer<typeof createTenantSchema>,
    @CurrentPlatformAdmin() admin: PlatformAuth,
  ): Promise<{ id: string; slug: string }> {
    const { id, slug } = await this.tenants.provision(body, { type: 'platform_admin', id: admin.platformAdminId });
    return { id, slug };
  }

  @ApiDoc({
    summary: 'List tenants, newest first.',
    description: 'Pass `next_cursor` back as `cursor` for the next page.',
    query: listSchema,
    response: pageSchema(tenantResponseSchema),
    errors: [400, 401, 403],
  })
  @RequirePermission('platform.tenant.read')
  @Get()
  list(@Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>): Promise<Page<TenantResponse>> {
    return this.tenants.list(query);
  }

  @ApiDoc({
    summary: 'Suspend a tenant: its users are refused from their next request on.',
    description: 'Suspending a suspended tenant changes nothing.',
    errors: [400, 401, 403, 404],
  })
  @RequirePermission('platform.tenant.suspend')
  @Post(':id/suspend')
  @HttpCode(204)
  async suspend(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @CurrentPlatformAdmin() admin: PlatformAuth,
  ): Promise<void> {
    await this.tenants.suspend(id, { type: 'platform_admin', id: admin.platformAdminId });
  }
}
