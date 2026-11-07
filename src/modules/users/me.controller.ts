import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { ApiDoc } from '../../docs/api-doc';
import { CourierAccountService } from '../couriers/courier-account.service';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { TENANT_PERMISSIONS } from '../identity/permissions';
import { Authenticated } from '../identity/route-markers';
import { USER_KINDS, toUserResponse, userResponseSchema } from './user-response';
import type { UserKind } from './user-response';

export const meResponseSchema = z.strictObject({
  /** Where the caller works: staff in the web app, partner people in its partner portal, customer people on the customer site. */
  kind: z.enum(USER_KINDS),
  user: userResponseSchema,
  /** The workspace signed in to; dates and money are shown in its time zone and currency. */
  workspace: z.strictObject({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    default_currency: z.string(),
    timezone: z.string(),
    /** Whether the workspace has a courier account, so labels can be bought when shipping. */
    labels_available: z.boolean(),
  }),
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly courierAccounts: CourierAccountService,
  ) {}

  @ApiDoc({
    summary: "The caller's own kind, user, workspace, roles, permissions and memberships.",
    description:
      '`kind` says where the caller works (staff, partner or customer), whatever memberships they have left. ' +
      "`workspace` gives the name, currency and time zone screens show dates and money in, and whether labels can " +
      'be bought when shipping (`labels_available`), never anything of the courier account.',
    response: meResponseSchema,
    errors: [401],
  })
  @Authenticated()
  @Get()
  async me(@CurrentUser() auth: TenantAuth): Promise<MeResponse> {
    const { user, tenant, labelsAvailable } = await this.prisma.inTenant(auth.tenantId, async (tx) => ({
      user: await tx.user.findUniqueOrThrow({
        where: { id: auth.userId },
        include: {
          roles: { select: { role: { select: { id: true, name: true } } } },
          memberships: true,
        },
      }),
      tenant: await tx.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
        select: { id: true, slug: true, name: true, defaultCurrency: true, timezone: true },
      }),
      labelsAvailable: await this.courierAccounts.configured(tx),
    }));

    return {
      kind: user.kind as UserKind,
      user: toUserResponse(user),
      workspace: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        default_currency: tenant.defaultCurrency,
        timezone: tenant.timezone,
        labels_available: labelsAvailable,
      },
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
