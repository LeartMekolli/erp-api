import { newId } from '../src/common/ids/uuid';
import type { PrismaService } from '../src/database/prisma.service';
import { hashPassword } from '../src/modules/identity/passwords';
import { SYSTEM_ROLES } from '../src/modules/identity/permissions';
import { createSystemRoles } from '../src/modules/identity/system-roles';

export const TEST_PASSWORD = 'test-password-123';

/**
 * A tenant with its two system roles, as provisioning creates it. Every user
 * factory below takes the tenant id, so a test cannot create a user without
 * one (spec 8.3).
 */
export async function createTestTenant(
  prisma: PrismaService,
  overrides: { slug?: string; status?: string } = {},
): Promise<{ id: string; slug: string }> {
  const id = newId();
  const slug = overrides.slug ?? `t-${id.slice(-12)}`;

  await prisma.inTenant(id, async (tx) => {
    await tx.tenant.create({
      data: {
        id,
        name: `Tenant ${slug}`,
        slug,
        status: overrides.status ?? 'active',
        defaultCurrency: 'EUR',
        defaultLocale: 'en',
        timezone: 'UTC',
      },
    });

    await createSystemRoles(tx);
  });

  return { id, slug };
}

export async function createTestUser(
  prisma: PrismaService,
  tenantId: string,
  options: { roles?: (keyof typeof SYSTEM_ROLES)[]; email?: string; password?: string; status?: string } = {},
): Promise<{ id: string; email: string; password: string }> {
  const password = options.password ?? TEST_PASSWORD;
  const email = options.email ?? `user-${newId()}@example.test`;
  const passwordHash = await hashPassword(password);

  const user = await prisma.inTenant(tenantId, async (tx) => {
    const created = await tx.user.create({
      data: { email, passwordHash, name: 'Test User', locale: 'en', status: options.status ?? 'active' },
    });
    const roles = await tx.role.findMany({ where: { name: { in: options.roles ?? ['member'] } } });
    await tx.userRole.createMany({ data: roles.map((role) => ({ userId: created.id, roleId: role.id })) });
    return created;
  });

  return { id: user.id, email, password };
}

/** Tenants are cleaned up by cascade; audit entries deliberately survive. */
export async function deleteTestTenants(prisma: PrismaService, ids: string[]): Promise<void> {
  await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
}
