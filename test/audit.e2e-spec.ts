import { Test } from '@nestjs/testing';
import { requestContext } from '../src/common/request-context/request-context';
import { ConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { AuditModule } from '../src/modules/audit/audit.module';
import { AuditService } from '../src/modules/audit/audit.service';
import { createTestTenant, deleteTestTenants } from './factories';

describe('audit service', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule, AuditModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    audit = moduleRef.get(AuditService);
    tenantA = (await createTestTenant(prisma)).id;
    tenantB = (await createTestTenant(prisma)).id;
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, [tenantA, tenantB]);
    await prisma.$disconnect();
  });

  it("records an entry with the request id, inside the caller's transaction", async () => {
    const actorId = '01a145c3-7e73-728d-9d82-1f426e70d11e';

    await requestContext.run({ requestId: 'req-audit-1' }, () =>
      prisma.inTenant(tenantA, (tx) =>
        audit.record(tx, {
          actor: { type: 'user', id: actorId },
          action: 'role.created',
          subject: { type: 'role', id: actorId },
          after: { name: 'Production lead' },
        }),
      ),
    );

    const entries = await prisma.inTenant(tenantA, (tx) =>
      tx.auditEntry.findMany({ where: { requestId: 'req-audit-1' } }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tenantId: tenantA,
      actorType: 'user',
      actorId,
      action: 'role.created',
      subjectType: 'role',
      subjectId: actorId,
      before: null,
      after: { name: 'Production lead' },
    });
  });

  it('records without a request id outside a request', async () => {
    await prisma.inTenant(tenantA, (tx) =>
      audit.record(tx, { actor: { type: 'system' }, action: 'tenant.suspended', subject: { type: 'tenant' } }),
    );

    const entry = await prisma.inTenant(tenantA, (tx) =>
      tx.auditEntry.findFirstOrThrow({ where: { action: 'tenant.suspended' } }),
    );
    expect(entry).toMatchObject({ requestId: null, actorId: null, subjectId: null });
  });

  it('rolls back with the caller', async () => {
    await expect(
      prisma.inTenant(tenantA, async (tx) => {
        await audit.record(tx, {
          actor: { type: 'system' },
          action: 'user.deactivated',
          subject: { type: 'user' },
        });
        throw new Error('the change itself failed');
      }),
    ).rejects.toThrow('the change itself failed');

    await expect(
      prisma.inTenant(tenantA, (tx) => tx.auditEntry.count({ where: { action: 'user.deactivated' } })),
    ).resolves.toBe(0);
  });

  it('is invisible to another tenant', async () => {
    await expect(prisma.inTenant(tenantB, (tx) => tx.auditEntry.count())).resolves.toBe(0);
  });
});
