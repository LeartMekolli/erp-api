import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import type { UserResponse } from './user-response';
import { UsersService } from './users.service';

const listSchema = paginationQuerySchema.extend({
  status: z.enum(['active', 'deactivated']).optional(),
});

const idSchema = z.uuid();

const setRolesSchema = z.object({
  role_ids: z
    .array(z.uuid())
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, 'role_ids must not repeat'),
});

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @ApiDoc({
    summary: "List the tenant's users, newest first.",
    description: 'A page of users: `data` and `next_cursor`, which goes back as `cursor` for the next page.',
    query: listSchema,
    errors: [400, 401, 403],
  })
  @RequirePermission('user.read')
  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>,
  ): Promise<Page<UserResponse>> {
    return this.users.list(tenantId, query);
  }

  @ApiDoc({
    summary: 'Deactivate a user: their sessions end and they can no longer log in.',
    description: 'The last active owner cannot be deactivated (409).',
    errors: [400, 401, 403, 404, 409],
  })
  @RequirePermission('user.deactivate')
  @Post(':id/deactivate')
  @HttpCode(204)
  async deactivate(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.users.deactivate(auth, id);
  }

  @ApiDoc({
    summary: "Replace a user's roles.",
    description: 'Answers the role ids the user now has. Ids must not repeat.',
    body: setRolesSchema,
    errors: [400, 401, 403, 404, 409],
  })
  @RequirePermission('role.assign')
  @Put(':id/roles')
  setRoles(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(setRolesSchema)) body: z.infer<typeof setRolesSchema>,
  ): Promise<{ role_ids: string[] }> {
    return this.users.setRoles(auth, id, body.role_ids);
  }
}
