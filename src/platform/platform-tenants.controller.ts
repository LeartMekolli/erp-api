import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
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

const aiLimitSchema = z.strictObject({
  // USD, at most 2 decimal places; null removes the limit, and with it the workspace's AI.
  monthly_usd: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,2})?$/, 'must be an amount in USD, such as 20.00')
    .nullable(),
});

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
    summary: 'One tenant, as the list shows it.',
    response: tenantResponseSchema,
    errors: [400, 401, 403, 404],
  })
  @RequirePermission('platform.tenant.read')
  @Get(':id')
  get(@Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<TenantResponse> {
    return this.tenants.get(id);
  }

  @ApiDoc({
    summary: "Send the tenant owner's invitation again, with a new link that replaces the old one.",
    description:
      'For an owner invitation that was lost. Only while the owner has not accepted it, and not for a suspended tenant (409).',
    errors: [400, 401, 403, 404, 409],
  })
  @RequirePermission('platform.tenant.create')
  @Post(':id/owner-invitation')
  @HttpCode(204)
  async resendOwnerInvitation(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @CurrentPlatformAdmin() admin: PlatformAuth,
  ): Promise<void> {
    await this.tenants.resendOwnerInvitation(id, { type: 'platform_admin', id: admin.platformAdminId });
  }

  @ApiDoc({
    summary: 'Reactivate a suspended tenant: its users get in again from their next request on.',
    description: 'Reactivating an active tenant changes nothing.',
    errors: [400, 401, 403, 404],
  })
  @RequirePermission('platform.tenant.suspend')
  @Post(':id/reactivate')
  @HttpCode(204)
  async reactivate(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @CurrentPlatformAdmin() admin: PlatformAuth,
  ): Promise<void> {
    await this.tenants.reactivate(id, { type: 'platform_admin', id: admin.platformAdminId });
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

  @ApiDoc({
    summary: "Set or remove a tenant's monthly AI limit in USD.",
    description:
      'A tenant without a limit has no AI. Runs are refused once the UTC month\'s spend reaches the limit; ' +
      "answers the tenant view with the month's spend.",
    body: aiLimitSchema,
    response: tenantResponseSchema,
    errors: [400, 401, 403, 404],
  })
  @RequirePermission('platform.tenant.ai')
  @Put(':id/ai-limit')
  setAiLimit(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(aiLimitSchema)) body: z.infer<typeof aiLimitSchema>,
    @CurrentPlatformAdmin() admin: PlatformAuth,
  ): Promise<TenantResponse> {
    return this.tenants.setAiLimit(id, body.monthly_usd, { type: 'platform_admin', id: admin.platformAdminId });
  }
}
