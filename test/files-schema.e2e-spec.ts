import { Test } from '@nestjs/testing';
import { newId } from '../src/common/ids/uuid';
import { ConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';

/**
 * Database-level guarantees of the file tables, checked as erp_app. The
 * tenancy coverage test separately asserts each one has RLS.
 */
describe('files schema', () => {
  let prisma: PrismaService;
  const tenantA = newId();
  const tenantB = newId();
  let userA: string;
  let userB: string;

  const createUser = (tenantId: string, email: string) =>
    prisma.inTenant(tenantId, (tx) =>
      tx.user.create({ data: { email, passwordHash: 'not-a-real-hash', name: 'F', locale: 'en' } }),
    );

  const createFile = (tenantId: string, userId: string) =>
    prisma.inTenant(tenantId, (tx) =>
      tx.file.create({ data: { kind: 'document', name: 'report.pdf', createdByUserId: userId } }),
    );

  const createVersion = (tenantId: string, fileId: string, userId: string, number = 1) =>
    prisma.inTenant(tenantId, (tx) =>
      tx.fileVersion.create({
        data: {
          fileId,
          number,
          storageKey: `${tenantId}/${fileId}/${newId()}`,
          originalName: 'report.pdf',
          contentType: 'application/pdf',
          size: 1024n,
          status: 'pending',
          uploadedByUserId: userId,
        },
      }),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule, DatabaseModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);

    for (const [index, id] of [tenantA, tenantB].entries()) {
      await prisma.tenant.create({
        data: {
          id,
          name: `Files ${index}`,
          slug: `f-${index}-${id.slice(-8)}`,
          defaultCurrency: 'EUR',
          defaultLocale: 'en',
          timezone: 'UTC',
        },
      });
    }
    userA = (await createUser(tenantA, 'a@example.test')).id;
    userB = (await createUser(tenantB, 'b@example.test')).id;
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
  });

  it("refuses a version pointing at another tenant's file", async () => {
    const fileB = await createFile(tenantB, userB);

    // RLS hides tenant B's file, but foreign-key checks bypass RLS: only the
    // composite (tenant_id, file_id) key stops this.
    await expect(createVersion(tenantA, fileB.id, userA)).rejects.toMatchObject({ code: 'P2003' });
  });

  it("refuses a file naming another tenant's user as its creator", async () => {
    // The user keys are checked at commit (deferred), so the refusal is the
    // driver adapter's error from COMMIT, not a P2003 from the insert.
    await expect(createFile(tenantA, userB)).rejects.toMatchObject({
      cause: {
        kind: 'ForeignKeyConstraintViolation',
        constraint: { index: 'file_tenant_id_created_by_user_id_fkey' },
      },
    });
  });

  it("numbers a file's versions once each", async () => {
    const file = await createFile(tenantA, userA);
    await createVersion(tenantA, file.id, userA, 1);

    await expect(createVersion(tenantA, file.id, userA, 1)).rejects.toMatchObject({ code: 'P2002' });
    await expect(createVersion(tenantA, file.id, userA, 2)).resolves.toMatchObject({ number: 2 });
  });

  it('scopes the tables to their tenant', async () => {
    const file = await createFile(tenantA, userA);
    const version = await createVersion(tenantA, file.id, userA);
    await prisma.inTenant(tenantA, (tx) =>
      tx.measure.create({ data: { fileVersionId: version.id, type: 'page_count', value: '3', unit: 'count' } }),
    );

    const fromB = await prisma.inTenant(tenantB, async (tx) => ({
      files: await tx.file.count({ where: { id: file.id } }),
      versions: await tx.fileVersion.count({ where: { fileId: file.id } }),
      measures: await tx.measure.count({ where: { fileVersionId: version.id } }),
    }));
    expect(fromB).toEqual({ files: 0, versions: 0, measures: 0 });

    const deleted = await prisma.inTenant(tenantB, async (tx) => ({
      measures: (await tx.measure.deleteMany({ where: { fileVersionId: version.id } })).count,
      versions: (await tx.fileVersion.deleteMany({ where: { id: version.id } })).count,
      files: (await tx.file.deleteMany({ where: { id: file.id } })).count,
    }));
    expect(deleted).toEqual({ measures: 0, versions: 0, files: 0 });

    const fromA = await prisma.inTenant(tenantA, async (tx) => ({
      files: await tx.file.count({ where: { id: file.id } }),
      versions: await tx.fileVersion.count({ where: { fileId: file.id } }),
      measures: await tx.measure.count({ where: { fileVersionId: version.id } }),
    }));
    expect(fromA).toEqual({ files: 1, versions: 1, measures: 1 });
  });

  it('removes versions and measures with their file', async () => {
    const file = await createFile(tenantA, userA);
    const version = await createVersion(tenantA, file.id, userA);
    await prisma.inTenant(tenantA, (tx) =>
      tx.measure.create({ data: { fileVersionId: version.id, type: 'width', value: '210.5', unit: 'mm' } }),
    );

    await prisma.inTenant(tenantA, (tx) => tx.file.delete({ where: { id: file.id } }));

    const left = await prisma.inTenant(tenantA, async (tx) => ({
      versions: await tx.fileVersion.count({ where: { fileId: file.id } }),
      measures: await tx.measure.count({ where: { fileVersionId: version.id } }),
    }));
    expect(left).toEqual({ versions: 0, measures: 0 });
  });
});
