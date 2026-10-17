import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { TENANT_PERMISSIONS } from '../identity/permissions';
import { RequirePermission } from '../identity/route-markers';
import { RolesService } from './roles.service';
import type { RoleResponse } from './roles.service';

// Tenant permissions only: a platform permission in a role body is a 400.
const permissionsSchema = z
  .array(z.enum(TENANT_PERMISSIONS))
  .max(TENANT_PERMISSIONS.length)
  .refine((permissions) => new Set(permissions).size === permissions.length, 'permissions must not repeat');

const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(50),
  permissions: permissionsSchema,
});

const setPermissionsSchema = z.object({ permissions: permissionsSchema });

const idSchema = z.uuid();

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @RequirePermission('role.read')
  @Get()
  list(@CurrentTenant() tenantId: string): Promise<{ data: RoleResponse[] }> {
    return this.roles.list(tenantId);
  }

  @RequirePermission('role.write')
  @Post()
  create(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createRoleSchema)) body: z.infer<typeof createRoleSchema>,
  ): Promise<RoleResponse> {
    return this.roles.create(auth, body);
  }

  @RequirePermission('role.write')
  @Put(':id/permissions')
  setPermissions(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(setPermissionsSchema)) body: z.infer<typeof setPermissionsSchema>,
  ): Promise<RoleResponse> {
    return this.roles.setPermissions(auth, id, body.permissions);
  }

  @RequirePermission('role.write')
  @Delete(':id')
  @HttpCode(204)
  async delete(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.roles.delete(auth, id);
  }
}
