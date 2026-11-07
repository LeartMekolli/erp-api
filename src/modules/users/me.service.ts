import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CourierAccountService } from '../couriers/courier-account.service';
import type { TenantAuth } from '../identity/auth-context';
import type { MeResponse, UpdateMe } from './me.controller';
import { toUserResponse } from './user-response';
import type { UserKind } from './user-response';

/** The caller's own identity, and the little of it they change themselves (Orders list extras spec, goal 4). */
@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly courierAccounts: CourierAccountService,
  ) {}

  async view(auth: TenantAuth): Promise<MeResponse> {
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

  /** Changes the caller's own locale, audited; the locale they already have changes and records nothing. */
  async update(auth: TenantAuth, body: UpdateMe): Promise<MeResponse> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const { locale } = await tx.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { locale: true } });
      if (locale === body.locale) return;
      await tx.user.update({ where: { id: auth.userId }, data: { locale: body.locale } });
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'user.locale_changed',
        subject: { type: 'user', id: auth.userId },
        before: { locale },
        after: { locale: body.locale },
      });
    });
    return this.view(auth);
  }
}
