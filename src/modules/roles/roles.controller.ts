import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { TENANT_PERMISSIONS } from '../identity/permissions';
import { RequirePermission } from '../identity/route-markers';
import { roleListResponseSchema, roleResponseSchema } from './role-response';
import type { RoleResponse } from './role-response';
import { RolesService } from './roles.service';

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

const renameRoleSchema = z.object({ name: z.string().trim().min(1).max(50) });

const idSchema = z.uuid();

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @ApiDoc({
    summary: "List the tenant's roles with their permissions.",
    description:
      'Answers `data`: each role with `id`, `name`, `is_system`, `permissions`, `members_count` (active people) ' +
      'and `invitations_count` (waiting invitations).',
    response: roleListResponseSchema,
    errors: [401, 403],
  })
  @RequirePermission('role.read')
  @Get()
  list(@CurrentTenant() tenantId: string): Promise<{ data: RoleResponse[] }> {
    return this.roles.list(tenantId);
  }

  @ApiDoc({
    summary: 'Create a custom role with a set of tenant permissions.',
    description:
      'Answers the new role. Names are unique per tenant (409 `name_taken`); permissions must not repeat. ' +
      'Unless the caller is an owner, every permission must be one they hold (403 `exceeds_own_permissions`).',
    body: createRoleSchema,
    response: roleResponseSchema,
    errors: [400, 401, 403, 409],
  })
  @RequirePermission('role.write')
  @Post()
  create(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createRoleSchema)) body: z.infer<typeof createRoleSchema>,
  ): Promise<RoleResponse> {
    return this.roles.create(auth, body);
  }

  @ApiDoc({
    summary: "Replace a custom role's permissions.",
    description:
      'Answers the updated role. System roles cannot be changed (409 `system_role`). Unless the caller is an owner, ' +
      'every permission added or removed must be one they hold (403 `exceeds_own_permissions`). ' +
      'Takes effect from the next request.',
    body: setPermissionsSchema,
    response: roleResponseSchema,
    errors: [400, 401, 403, 404, 409],
  })
  @RequirePermission('role.write')
  @Put(':id/permissions')
  setPermissions(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(setPermissionsSchema)) body: z.infer<typeof setPermissionsSchema>,
  ): Promise<RoleResponse> {
    return this.roles.setPermissions(auth, id, body.permissions);
  }

  @ApiDoc({
    summary: 'Rename a custom role.',
    description:
      'Answers the renamed role. A name another role has is a 409 `name_taken`; system roles cannot be renamed ' +
      "(409 `system_role`). Renaming to the role's own name changes nothing.",
    body: renameRoleSchema,
    response: roleResponseSchema,
    errors: [400, 401, 403, 404, 409],
  })
  @RequirePermission('role.write')
  @Patch(':id')
  rename(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(renameRoleSchema)) body: z.infer<typeof renameRoleSchema>,
  ): Promise<RoleResponse> {
    return this.roles.rename(auth, id, body.name);
  }

  @ApiDoc({
    summary: 'Delete a custom role.',
    description:
      'Its invitations are deleted with it, so they no longer appear in the invitations list. System roles cannot be deleted (409 `system_role`). ' +
      'Refused with 403 `exceeds_own_permissions` when the caller lacks a permission the role holds, and with ' +
      '409 `only_role` (`people`: `id`, `name`, `status`) when someone, deactivated or not, would be left with no role.',
    errors: [400, 401, 403, 404, 409],
  })
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
