import { Test } from '@nestjs/testing';
import { newId } from '../src/common/ids/uuid';
import { ConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';

/**
 * Database-level guarantees of the notification tables, checked as erp_app.
 * The tenancy coverage test separately asserts each one has RLS.
 */
describe('notifications schema', () => {
  let prisma: PrismaService;
  const tenantA = newId();
  const tenantB = newId();
  let userA: string;
  let userB: string;
  let notificationA: string;

  const createUser = (tenantId: string, email: string) =>
    prisma.inTenant(tenantId, (tx) =>
      tx.user.create({ data: { email, passwordHash: 'not-a-real-hash', name: 'N', locale: 'en' } }),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule, DatabaseModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);

    for (const [index, id] of [tenantA, tenantB].entries()) {
      await prisma.tenant.create({
        data: {
          id,
          name: `Notifications ${index}`,
          slug: `n-${index}-${id.slice(-8)}`,
          defaultCurrency: 'EUR',
          defaultLocale: 'en',
          timezone: 'UTC',
        },
      });
    }
    userA = (await createUser(tenantA, 'a@example.test')).id;
    userB = (await createUser(tenantB, 'b@example.test')).id;

    const notification = await prisma.inTenant(tenantA, (tx) =>
      tx.notification.create({
        data: {
          eventKey: 'user.roles_changed',
          audience: 'user',
          subjectType: 'user',
          subjectId: userA,
          payload: { user_name: 'A', roles: 'owner' },
          status: 'pending',
        },
      }),
    );
    notificationA = notification.id;
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
  });

  it('accepts a recipient within the tenant', async () => {
    await expect(
      prisma.inTenant(tenantA, (tx) =>
        tx.notificationRecipient.create({
          data: { notificationId: notificationA, userId: userA, title: 'Roles changed', body: 'Now: owner' },
        }),
      ),
    ).resolves.toMatchObject({ tenantId: tenantA, readAt: null });
  });

  it("refuses a recipient pointing at another tenant's user", async () => {
    // RLS hides tenant B's user, but foreign-key checks bypass RLS: only the
    // composite (tenant_id, user_id) key stops this.
    await expect(
      prisma.inTenant(tenantA, (tx) =>
        tx.notificationRecipient.create({
          data: { notificationId: notificationA, userId: userB, title: 't', body: 'b' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('makes notification_delivery append-only', async () => {
    const delivery = await prisma.inTenant(tenantA, (tx) =>
      tx.notificationDelivery.create({
        data: { notificationId: notificationA, channel: 'email', target: 'a@example.test', status: 'sent', attempt: 1 },
      }),
    );

    await expect(
      prisma.inTenant(tenantA, (tx) =>
        tx.notificationDelivery.updateMany({ where: { id: delivery.id }, data: { status: 'failed' } }),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      prisma.inTenant(tenantA, (tx) => tx.notificationDelivery.deleteMany({ where: { id: delivery.id } })),
    ).rejects.toThrow(/permission denied/i);
  });

  it('keeps one template override per tenant, event and locale', async () => {
    const data = { eventKey: 'user.invited', locale: 'en', subject: 's', body: '{{ link }}' };

    await prisma.inTenant(tenantA, (tx) => tx.notificationTemplate.create({ data }));
    await expect(prisma.inTenant(tenantB, (tx) => tx.notificationTemplate.create({ data }))).resolves.toBeDefined();
    await expect(prisma.inTenant(tenantA, (tx) => tx.notificationTemplate.create({ data }))).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('scopes the new tables to their tenant', async () => {
    const fromB = await prisma.inTenant(tenantB, async (tx) => ({
      notifications: await tx.notification.count({ where: { id: notificationA } }),
      recipients: await tx.notificationRecipient.count({ where: { notificationId: notificationA } }),
      deliveries: await tx.notificationDelivery.count({ where: { notificationId: notificationA } }),
    }));

    expect(fromB).toEqual({ notifications: 0, recipients: 0, deliveries: 0 });
    await expect(
      prisma.inTenant(tenantB, (tx) => tx.notification.deleteMany({ where: { id: notificationA } })),
    ).resolves.toEqual({ count: 0 });
  });
});
