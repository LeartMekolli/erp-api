import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { type StaffUserResponse, staffUserListResponseSchema } from './user-response';
import { UsersService } from './users.service';

const listSchema = paginationQuerySchema.extend({
  status: z.enum(['active', 'deactivated']).optional(),
  q: z.string().trim().min(1).max(100).optional(),
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
    description:
      'A page of users: `data` and `next_cursor`, which goes back as `cursor` for the next page. ' +
      '`q` keeps the people whose name or email contains it, ignoring case. ' +
      "Each person carries their `roles` (by name, with `is_system`) and their `skills` (by name): `expires_on` is the last day, " +
      "`expired` is set once that day has passed in the workspace's time zone, and `archived` marks a skill that has left the catalogue.",
    query: listSchema,
    response: staffUserListResponseSchema,
    errors: [400, 401, 403],
  })
  @RequirePermission('user.read')
  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>,
  ): Promise<Page<StaffUserResponse>> {
    return this.users.list(tenantId, query);
  }

  @ApiDoc({
    summary: 'Deactivate a user: their sessions end and they can no longer log in.',
    description:
      "You can't deactivate yourself (409 `own_account`). Only an owner may deactivate an owner (403 `owner_only`), " +
      'and nobody may deactivate a person who holds permissions they lack (403 `person_holds_more`, listing the missing ones). ' +
      'The last active owner cannot be deactivated (409 `last_owner`).',
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
    summary: 'Reactivate a deactivated staff member: they sign in again with their old password and keep their roles and skills.',
    description:
      'Idempotent: an active user answers 204 and nothing is recorded or sent. The same rules as deactivating apply: ' +
      'only an owner may reactivate an owner (403 `owner_only`), and nobody may reactivate a person who holds permissions ' +
      'they lack (403 `person_holds_more`). The person is told by email when their status changed.',
    errors: [400, 401, 403, 404],
  })
  @RequirePermission('user.deactivate')
  @Post(':id/reactivate')
  @HttpCode(204)
  async reactivate(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.users.reactivate(auth, id);
  }

  @ApiDoc({
    summary: "Replace a user's roles.",
    description:
      'Answers the role ids the user now has. Ids must not repeat. Only an owner may add or remove the owner role (403 `owner_only`). ' +
      'Every other role added or removed must hold only permissions the caller has (403 `exceeds_own_permissions`, listing the missing ones). ' +
      'Removing the last active owner is refused (409 `last_owner`).',
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
