import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { newId } from '../common/ids/uuid';
import { decodeCursor } from '../common/pagination/cursor';
import { Page, toPage } from '../common/pagination/page';
import { ConfigService } from '../config/config.service';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { Tenant } from '../generated/prisma/client';
import { aiSpent } from '../modules/ai/runs.service';
import { AuditInput, AuditService } from '../modules/audit/audit.service';
import { IDENTITY_NOTIFIER } from '../modules/identity/identity-notifier';
import type { IdentityNotifier } from '../modules/identity/identity-notifier';
import { createInvitation } from '../modules/identity/invitations';
import { createSystemRoles } from '../modules/identity/system-roles';
import { createDefaultPlan } from '../modules/payments/plans/default-plan';
import { CreateTenantInput, createTenantSchema } from './tenant-input';

export type TenantStatus = 'active' | 'suspended';

export const tenantResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  default_currency: z.string(),
  default_locale: z.string(),
  timezone: z.string(),
  created_at: z.string(),
  // In USD, to the cent. A null limit means the workspace has no AI.
  ai: z.strictObject({
    monthly_limit_usd: z.string().nullable(),
    spent_this_month_usd: z.string(),
  }),
});
export type TenantResponse = z.infer<typeof tenantResponseSchema>;

/**
 * Platform-level tenant administration (ADR 0001: a platform-admin action).
 * Exposed over HTTP by PlatformApiModule and used directly by the CLI and seed.
 */
@Injectable()
export class TenantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    @Inject(IDENTITY_NOTIFIER) private readonly notifier: IdentityNotifier,
  ) {}

  /**
   * One transaction: the tenant, its system roles, the owner's invitation and
   * the audit entry exist together or not at all. The id is generated first so
   * the transaction can run as that tenant. The owner is notified only after
   * commit, so no email points at a tenant that was rolled back.
   *
   * Throws a ZodError for invalid input and a ConflictException for a taken
   * slug; the unique constraint decides the conflict, so concurrent creates
   * cannot both succeed.
   */
  async provision(
    input: CreateTenantInput,
    actor: AuditInput['actor'],
  ): Promise<{ id: string; slug: string; invitationId: string }> {
    const tenant = createTenantSchema.parse(input);
    const id = newId();

    let invitation: { invitationId: string; token: string };
    try {
      invitation = await this.prisma.inTenant(id, async (tx) => {
        await tx.tenant.create({
          data: {
            id,
            name: tenant.name,
            slug: tenant.slug,
            defaultCurrency: tenant.currency,
            defaultLocale: tenant.locale,
            timezone: tenant.timezone,
          },
        });
        const roles = await createSystemRoles(tx);
        await createDefaultPlan(tx);
        const created = await createInvitation(tx, id, { email: tenant.ownerEmail, roleId: roles.owner });
        await this.audit.record(tx, {
          actor,
          action: 'tenant.created',
          subject: { type: 'tenant', id },
          after: { name: tenant.name, slug: tenant.slug, ownerEmail: tenant.ownerEmail },
        });
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Slug ${tenant.slug} is taken`);
      }
      throw error;
    }

    await this.notifier.invitationCreated({
      tenantId: id,
      invitationId: invitation.invitationId,
      email: tenant.ownerEmail,
      token: invitation.token,
    });

    return { id, slug: tenant.slug, invitationId: invitation.invitationId };
  }

  async list(query: { limit: number; cursor?: string; status?: TenantStatus }): Promise<Page<TenantResponse>> {
    const after = query.cursor ? decodeCursor(query.cursor, this.config.get('APP_SECRET')) : undefined;
    const rows = await this.prisma.tenant.findMany({
      where: { status: query.status, ...(after ? { id: { lt: after.id } } : {}) },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit, this.config.get('APP_SECRET'));

    const data: TenantResponse[] = [];
    for (const row of page.data) {
      // The run log is behind each workspace's row-level security.
      data.push(this.toResponse(row, await this.prisma.inTenant(row.id, (tx) => aiSpent(tx, new Date()))));
    }
    return { next_cursor: page.next_cursor, data };
  }

  /** Sets or removes (null) the workspace's monthly AI limit in USD, audited; answers the tenant view. */
  async setAiLimit(id: string, monthlyUsd: string | null, actor: AuditInput['actor']): Promise<TenantResponse> {
    return this.prisma.inTenant(id, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id }, select: { aiMonthlyLimitUsd: true } });
      if (!tenant) {
        throw new NotFoundException('Tenant not found');
      }
      const updated = await tx.tenant.update({
        where: { id },
        data: { aiMonthlyLimitUsd: monthlyUsd === null ? null : new Prisma.Decimal(monthlyUsd) },
      });
      await this.audit.record(tx, {
        actor,
        action: 'tenant.ai_limit_set',
        subject: { type: 'tenant', id },
        before: { monthlyUsd: tenant.aiMonthlyLimitUsd?.toFixed(2) ?? null },
        after: { monthlyUsd: updated.aiMonthlyLimitUsd?.toFixed(2) ?? null },
      });
      return this.toResponse(updated, await aiSpent(tx, new Date()));
    });
  }

  private toResponse(row: Tenant, aiSpentThisMonth: Prisma.Decimal): TenantResponse {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      default_currency: row.defaultCurrency,
      default_locale: row.defaultLocale,
      timezone: row.timezone,
      created_at: row.createdAt.toISOString(),
      ai: {
        monthly_limit_usd: row.aiMonthlyLimitUsd?.toFixed(2) ?? null,
        spent_this_month_usd: aiSpentThisMonth.toFixed(2),
      },
    };
  }

  /**
   * Idempotent: suspending a suspended tenant changes nothing and records
   * nothing. Its users are refused from their next request on, because the
   * guard reads the tenant's status every time.
   */
  async suspend(id: string, actor: AuditInput['actor']): Promise<void> {
    await this.prisma.inTenant(id, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id }, select: { status: true } });
      if (!tenant) {
        throw new NotFoundException('Tenant not found');
      }
      if (tenant.status === 'suspended') {
        return;
      }

      await tx.tenant.update({ where: { id }, data: { status: 'suspended' } });
      await this.audit.record(tx, {
        actor,
        action: 'tenant.suspended',
        subject: { type: 'tenant', id },
        before: { status: tenant.status },
        after: { status: 'suspended' },
      });
    });
  }
}
