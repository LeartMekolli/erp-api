import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { TENANT_PERMISSIONS } from '../identity/permissions';
import { Authenticated } from '../identity/route-markers';
import { toUserResponse, userResponseSchema } from './user-response';

export const meResponseSchema = z.strictObject({
  user: userResponseSchema,
  roles: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
  permissions: z.array(z.enum(TENANT_PERMISSIONS)),
  memberships: z.array(
    z.strictObject({ organisation_type: z.string(), organisation_id: z.string(), role: z.string() }),
  ),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * The caller's own identity (spec 4.7). There is deliberately no lookup of
 * other users by email or external id.
 */
@Controller('me')
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  @ApiDoc({
    summary: "The caller's own user, roles, permissions and memberships.",
    response: meResponseSchema,
    errors: [401],
  })
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
