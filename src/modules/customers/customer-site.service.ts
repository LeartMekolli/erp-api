import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import type { CustomerSiteResponse } from './customer-response';

/** How long another instance may keep allowing a site that was just changed. */
const CACHE_MS = 60_000;

/** An https origin, written as browsers send it: no path, no trailing slash, lowercase host. */
const originSchema = z
  .string()
  .max(200)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === value;
    } catch {
      return false;
    }
  }, 'Must be an https origin such as https://shop.example, with no path');

export const customerSiteSchema = z.object({
  /** Null removes the site: customer emails link to the staff app again. */
  origin: originSchema.nullable(),
});

/**
 * The workspace's customer site (Customers spec, goal 13). It is stored on the
 * platform-owned tenant row, so the CORS check can read every active
 * workspace's site without a tenant scope. The set of sites is cached for up
 * to a minute; a change made through this instance applies at once.
 */
@Injectable()
export class CustomerSiteService {
  private cached?: { origins: ReadonlySet<string>; loadedAt: number };

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async set(auth: TenantAuth, origin: string | null): Promise<CustomerSiteResponse> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const before = await tx.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
        select: { customerSiteOrigin: true },
      });
      await tx.tenant.update({ where: { id: auth.tenantId }, data: { customerSiteOrigin: origin } });
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'workspace.customer_site_changed',
        subject: { type: 'tenant', id: auth.tenantId },
        before: { origin: before.customerSiteOrigin },
        after: { origin },
      });
    });
    this.cached = undefined;
    return { origin };
  }

  /** Whether `origin` is an active workspace's customer site, for CORS. */
  async isCustomerSite(origin: string): Promise<boolean> {
    if (!this.cached || Date.now() - this.cached.loadedAt > CACHE_MS) {
      const rows = await this.prisma.tenant.findMany({
        where: { status: 'active', customerSiteOrigin: { not: null } },
        select: { customerSiteOrigin: true },
      });
      this.cached = {
        origins: new Set(rows.flatMap((row) => (row.customerSiteOrigin ? [row.customerSiteOrigin] : []))),
        loadedAt: Date.now(),
      };
    }
    return this.cached.origins.has(origin);
  }
}
