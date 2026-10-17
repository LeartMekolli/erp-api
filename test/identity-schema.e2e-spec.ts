import { Test } from '@nestjs/testing';
import { newId } from '../src/common/ids/uuid';
import { ConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';

/**
 * Database-level guarantees of the identity schema, checked as erp_app. The
 * tenancy coverage test separately asserts every new tenant table has RLS.
 */
describe('identity schema', () => {
  let prisma: PrismaService;
  const tenantA = newId();
  const tenantB = newId();
  let userA: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);

    for (const [index, id] of [tenantA, tenantB].entries()) {
      await prisma.tenant.create({
        data: {
          id,
          name: `Identity ${index}`,
          slug: `i-${index}-${id.slice(-8)}`,
          defaultCurrency: 'EUR',
          defaultLocale: 'en',
          timezone: 'UTC',
        },
      });
    }

    const user = await prisma.inTenant(tenantA, (tx) =>
      tx.user.create({
        data: { email: 'a@example.test', passwordHash: 'not-a-real-hash', name: 'A', locale: 'en' },
      }),
    );
    userA = user.id;
  });

  afterAll(async () => {
    // Cascades through every tenant table except audit_entry, which has no
    // foreign key to tenant so its rows outlive the tenant.
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
  });

  it('accepts a role assignment within the tenant', async () => {
    const role = await prisma.inTenant(tenantA, (tx) => tx.role.create({ data: { name: 'own' } }));

    await expect(
      prisma.inTenant(tenantA, (tx) => tx.userRole.create({ data: { userId: userA, roleId: role.id } })),
    ).resolves.toMatchObject({ tenantId: tenantA, userId: userA, roleId: role.id });
  });

  it("refuses a role assignment pointing at another tenant's role", async () => {
    // RLS hides tenant B's role, but foreign-key checks bypass RLS: only the
    // composite (tenant_id, role_id) key stops this.
    const foreign = await prisma.inTenant(tenantB, (tx) => tx.role.create({ data: { name: 'foreign' } }));

    await expect(
      prisma.inTenant(tenantA, (tx) =>
        tx.userRole.create({ data: { userId: userA, roleId: foreign.id } }),
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('keeps users per tenant', async () => {
    const seenFromB = await prisma.inTenant(tenantB, (tx) => tx.user.findMany({ where: { id: userA } }));

    expect(seenFromB).toEqual([]);
  });

  it('allows the same email in two tenants but not twice in one', async () => {
    const data = { email: 'shared@example.test', passwordHash: 'x', name: 'S', locale: 'en' };

    await prisma.inTenant(tenantA, (tx) => tx.user.create({ data }));
    await expect(prisma.inTenant(tenantB, (tx) => tx.user.create({ data }))).resolves.toBeDefined();
    await expect(prisma.inTenant(tenantA, (tx) => tx.user.create({ data }))).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('makes audit_entry append-only', async () => {
    const entry = await prisma.inTenant(tenantA, (tx) =>
      tx.auditEntry.create({
        data: { actorType: 'system', action: 'tenant.created', subjectType: 'tenant', subjectId: tenantA },
      }),
    );

    expect(entry.createdAt).toBeInstanceOf(Date);
    await expect(
      prisma.inTenant(tenantA, (tx) =>
        tx.auditEntry.updateMany({ where: { id: entry.id }, data: { action: 'changed' } }),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      prisma.inTenant(tenantA, (tx) => tx.auditEntry.deleteMany({ where: { id: entry.id } })),
    ).rejects.toThrow(/permission denied/i);
  });

  it('keeps platform admins outside tenancy', async () => {
    const email = `admin-${newId()}@example.test`;
    const admin = await prisma.platformAdmin.create({
      data: { email, passwordHash: 'x', name: 'Admin' },
    });

    await expect(prisma.platformAdmin.findUnique({ where: { email } })).resolves.toMatchObject({
      id: admin.id,
      status: 'active',
    });
    await prisma.platformAdmin.delete({ where: { id: admin.id } });
  });
});
