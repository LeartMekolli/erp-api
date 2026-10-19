import { Test } from '@nestjs/testing';
import { ConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { SYSTEM_ROLES, SystemRoleName } from '../src/modules/identity/permissions';

/**
 * System roles are created from SYSTEM_ROLES when a tenant is provisioned, so
 * a permission added to the code later reaches existing tenants only through
 * a migration. This asks every tenant in the database whether its system
 * roles hold exactly what the code says.
 */
describe('system roles in the database', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule, DatabaseModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('every system role holds exactly its SYSTEM_ROLES permissions', async () => {
    const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true } });
    const drift: string[] = [];

    for (const tenant of tenants) {
      const roles = await prisma.inTenant(tenant.id, (tx) =>
        tx.role.findMany({ where: { isSystem: true }, include: { permissions: true } }),
      );
      for (const role of roles) {
        const expected = [...(SYSTEM_ROLES[role.name as SystemRoleName] ?? [])].sort();
        const actual = role.permissions.map((row) => row.permission).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          drift.push(`${tenant.slug}/${role.name}: has [${actual.join(', ')}], expected [${expected.join(', ')}]`);
        }
      }
    }

    expect(drift).toEqual([]);
  });
});
