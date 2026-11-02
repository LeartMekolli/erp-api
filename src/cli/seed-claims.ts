import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service';
import { DEFAULT_CLAIM_SETTINGS } from '../modules/claims/claim-settings';
import { hashPassword } from '../modules/identity/passwords';
import { SettingsService } from '../modules/settings/settings.service';

// Demo claims and scheduled reports for the demo workspace (Orders 3 spec): the claim settings at their
// defaults, a staff accountant with the Accountant role, and the accountant's monthly files on, for them.

const ACCOUNTANT = { email: 'accountant@demo.example.test', name: 'Demo accountant' };

export interface ClaimsSeed {
  counts: {
    /** 1 when `orders.claims` was set, 0 when the workspace had it. */
    claims: number;
    /** 1 when `reports.schedules` was set, 0 when the workspace had it. */
    schedules: number;
    accountants: number;
  };
  /** The accountant's password when created now; null when it existed. */
  password: string | null;
}

/**
 * Seeds the claim settings, the accountant and the schedules into one workspace. Idempotent: the
 * accountant is found by email and the settings by key, and anything found is left as it is. The demo
 * owner exists only once invited, so the accountant is the schedule's recipient. A new accountant gets
 * `options.password`, else a random one, returned for the caller to print once.
 */
export async function seedClaims(prisma: PrismaService, tenantId: string, options: { password?: string } = {}): Promise<ClaimsSeed> {
  const counts = { claims: 0, schedules: 0, accountants: 0 };
  const password = options.password ?? randomBytes(16).toString('base64url');
  // Hashed once, before the transaction, which should not wait on argon2.
  const passwordHash = await hashPassword(password);

  await prisma.inTenant(tenantId, async (tx) => {
    const settings = new SettingsService();
    if (!(await tx.tenantSetting.findFirst({ where: { key: 'orders.claims' } }))) {
      await settings.set(tx, 'orders.claims', DEFAULT_CLAIM_SETTINGS);
      counts.claims++;
    }

    let accountant = await tx.user.findFirst({ where: { email: ACCOUNTANT.email } });
    if (!accountant) {
      const { defaultLocale } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultLocale: true } });
      accountant = await tx.user.create({ data: { ...ACCOUNTANT, passwordHash, locale: defaultLocale, kind: 'staff' } });
      const role = await tx.role.findFirstOrThrow({ where: { name: 'accountant', isSystem: true } });
      await tx.userRole.create({ data: { userId: accountant.id, roleId: role.id } });
      counts.accountants++;
    }

    if (!(await tx.tenantSetting.findFirst({ where: { key: 'reports.schedules' } }))) {
      await settings.set(tx, 'reports.schedules', {
        accounting: { enabled: true, recipientUserIds: [accountant.id] },
        top_customers: { enabled: false, recipientUserIds: [] },
      });
      counts.schedules++;
    }
  });

  return { counts, password: counts.accountants > 0 ? password : null };
}
