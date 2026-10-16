import { Test } from '@nestjs/testing';
import { ConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';

interface TenantTable {
  table: string;
  enabled: boolean;
  forced: boolean;
  hasPolicy: boolean;
  hasDefault: boolean;
}

/**
 * Row-level security is the only tenancy layer, so a tenant-owned table that
 * a migration forgot to protect would be readable by every tenant. This asks
 * the database itself: any table with a tenant_id column must have RLS
 * enabled and forced, a policy, and the tenant_id default.
 */
describe('tenancy coverage', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const tenantTables = () => prisma.$queryRaw<TenantTable[]>`
    SELECT c.relname              AS "table",
           c.relrowsecurity       AS "enabled",
           c.relforcerowsecurity  AS "forced",
           EXISTS (
             SELECT 1 FROM pg_policies p
             WHERE p.schemaname = n.nspname AND p.tablename = c.relname
           )                      AS "hasPolicy",
           a.atthasdef            AS "hasDefault"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname`;

  it('finds the tenant-owned tables', async () => {
    // Without this, a query that silently matched nothing would pass the next test.
    const tables = (await tenantTables()).map((row) => row.table);

    expect(tables).toContain('tenant_setting');
  });

  it('protects every one of them', async () => {
    const unprotected = (await tenantTables()).filter(
      (row) => !(row.enabled && row.forced && row.hasPolicy && row.hasDefault),
    );

    expect(unprotected).toEqual([]);
  });
});
