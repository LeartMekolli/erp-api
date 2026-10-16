import { Test } from '@nestjs/testing';
import { newId } from '../src/common/ids/uuid';
import { ConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';

/**
 * Runs against the real Compose stack as the erp_app role, so every assertion
 * here is row-level security at work: no application code filters by tenant.
 */
describe('tenant isolation', () => {
  let prisma: PrismaService;
  const tenantA = newId();
  const tenantB = newId();
  let settingA: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);

    // The slug uses the tail of the id: a v7 uuid starts with a millisecond
    // timestamp, so two ids created in the same millisecond share their
    // leading digits and would produce the same slug.
    for (const [index, id] of [tenantA, tenantB].entries()) {
      await prisma.tenant.create({
        data: {
          id,
          name: `Tenant ${index}`,
          slug: `t-${index}-${id.slice(-8)}`,
          defaultCurrency: 'EUR',
          defaultLocale: 'en',
          timezone: 'UTC',
        },
      });
    }
  });

  afterAll(async () => {
    // Cascades to tenant_setting: referential actions bypass row security.
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
  });

  it('fills the id and the tenant from the transaction', async () => {
    const created = await prisma.inTenant(tenantA, (tx) =>
      tx.tenantSetting.create({
        data: { key: 'notification.sender', value: { email: 'a@example.test' } },
      }),
    );

    expect(created.tenantId).toBe(tenantA);
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    settingA = created.id;
  });

  it('rejects a create that names another tenant', async () => {
    await expect(
      prisma.inTenant(tenantA, (tx) =>
        tx.tenantSetting.create({ data: { tenantId: tenantB, key: 'smuggled', value: {} } }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('returns the row to its own tenant', async () => {
    const rows = await prisma.inTenant(tenantA, (tx) => tx.tenantSetting.findMany());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(tenantA);
  });

  it('hides it from another tenant, even by id', async () => {
    const rows = await prisma.inTenant(tenantB, (tx) => tx.tenantSetting.findMany());
    const byId = await prisma.inTenant(tenantB, (tx) =>
      tx.tenantSetting.findUnique({ where: { id: settingA } }),
    );

    expect(rows).toHaveLength(0);
    expect(byId).toBeNull();
  });

  it('counts only the current tenant rows', async () => {
    await expect(prisma.inTenant(tenantB, (tx) => tx.tenantSetting.count())).resolves.toBe(0);
    await expect(prisma.inTenant(tenantA, (tx) => tx.tenantSetting.count())).resolves.toBe(1);
  });

  it('scopes raw SQL the same way', async () => {
    const countAs = (tenantId: string) =>
      prisma.inTenant(tenantId, (tx) =>
        tx.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM tenant_setting`,
      );

    await expect(countAs(tenantB)).resolves.toEqual([{ count: 0 }]);
    await expect(countAs(tenantA)).resolves.toEqual([{ count: 1 }]);
  });

  it('cannot update another tenant row by id', async () => {
    await expect(
      prisma.inTenant(tenantB, (tx) =>
        tx.tenantSetting.update({
          where: { id: settingA },
          data: { value: { email: 'hijacked@example.test' } },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });

    const mine = await prisma.inTenant(tenantA, (tx) =>
      tx.tenantSetting.findUniqueOrThrow({ where: { id: settingA } }),
    );
    expect(mine.value).toEqual({ email: 'a@example.test' });
  });

  it('cannot delete another tenant row by id', async () => {
    await expect(
      prisma.inTenant(tenantB, (tx) => tx.tenantSetting.delete({ where: { id: settingA } })),
    ).rejects.toMatchObject({ code: 'P2025' });

    await expect(prisma.inTenant(tenantA, (tx) => tx.tenantSetting.count())).resolves.toBe(1);
  });

  it('rolls back everything in the block when it fails', async () => {
    await expect(
      prisma.inTenant(tenantA, async (tx) => {
        await tx.tenantSetting.create({ data: { key: 'half.done', value: {} } });
        throw new Error('fail after the write');
      }),
    ).rejects.toThrow('fail after the write');

    await expect(prisma.inTenant(tenantA, (tx) => tx.tenantSetting.count())).resolves.toBe(1);
  });

  it('shows nothing and accepts nothing outside a tenant scope', async () => {
    await expect(prisma.tenantSetting.findMany({ where: { id: settingA } })).resolves.toEqual([]);
    await expect(
      prisma.tenantSetting.create({ data: { key: 'orphan', value: {} } }),
    ).rejects.toThrow();
  });

  it('leaves platform-owned tables readable without a tenant', async () => {
    const tenants = await prisma.tenant.findMany({ where: { id: { in: [tenantA, tenantB] } } });

    expect(tenants).toHaveLength(2);
  });
});
