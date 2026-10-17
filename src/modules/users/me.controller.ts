import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import type { TenantPermission } from '../identity/permissions';
import { Authenticated } from '../identity/route-markers';
import { toUserResponse } from './user-response';
import type { UserResponse } from './user-response';

export interface MeResponse {
  user: UserResponse;
  roles: { id: string; name: string }[];
  permissions: TenantPermission[];
  memberships: { organisation_type: string; organisation_id: string; role: string }[];
}

/**
 * The caller's own identity (spec 4.7). There is deliberately no lookup of
 * other users by email or external id.
 */
@Controller('me')
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  @Authenticated()
  @Get()
  async me(@CurrentUser() auth: TenantAuth): Promise<MeResponse> {
    const user = await this.prisma.inTenant(auth.tenantId, (tx) =>
      tx.user.findUniqueOrThrow({
        where: { id: auth.userId },
        include: {
          roles: { select: { role: { select: { id: true, name: true } } } },
          memberships: true,
        },
      }),
    );

    return {
      user: toUserResponse(user),
      roles: user.roles.map(({ role }) => role).sort((a, b) => a.name.localeCompare(b.name)),
      // As the guard resolved them for this request.
      permissions: [...auth.permissions].sort(),
      memberships: user.memberships.map((membership) => ({
        organisation_type: membership.organisationType,
        organisation_id: membership.organisationId,
        role: membership.role,
      })),
    };
  }
}
