import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { newId } from '../src/common/ids/uuid';
import { ConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { SettingsModule } from '../src/modules/settings/settings.module';
import { SettingsService } from '../src/modules/settings/settings.service';

describe('tenant settings', () => {
  let prisma: PrismaService;
  let settings: SettingsService;
  const tenantA = newId();
  const tenantB = newId();
  const sender = { name: 'Ops', email: 'ops@example.test' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule, SettingsModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    settings = moduleRef.get(SettingsService);

    for (const [index, id] of [tenantA, tenantB].entries()) {
      await prisma.tenant.create({
        data: {
          id,
          name: `Tenant ${index}`,
          slug: `s-${index}-${id.slice(-8)}`,
          defaultCurrency: 'EUR',
          defaultLocale: 'en',
          timezone: 'UTC',
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
  });

  it('writes then reads a setting', async () => {
    await prisma.inTenant(tenantA, (tx) => settings.set(tx, 'notification.sender', sender));

    await expect(
      prisma.inTenant(tenantA, (tx) => settings.get(tx, 'notification.sender')),
    ).resolves.toEqual(sender);
  });

  it('updates in place rather than creating a second row', async () => {
    const changed = { name: 'Ops 2', email: 'ops2@example.test' };
    await prisma.inTenant(tenantA, (tx) => settings.set(tx, 'notification.sender', changed));

    const rows = await prisma.inTenant(tenantA, (tx) =>
      tx.tenantSetting.findMany({ where: { key: 'notification.sender' } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toEqual(changed);
  });

  it('reports a missing setting as not found', async () => {
    await expect(
      prisma.inTenant(tenantA, (tx) => settings.get(tx, 'business.calendar')),
    ).rejects.toThrow(NotFoundException);
  });

  it('keeps each tenant settings separate', async () => {
    await expect(
      prisma.inTenant(tenantB, (tx) => settings.get(tx, 'notification.sender')),
    ).rejects.toThrow(NotFoundException);

    await prisma.inTenant(tenantB, (tx) => settings.set(tx, 'notification.sender', sender));

    await expect(
      prisma.inTenant(tenantA, (tx) => settings.get(tx, 'notification.sender')),
    ).resolves.toEqual({ name: 'Ops 2', email: 'ops2@example.test' });
  });

  it('rolls back with the surrounding transaction', async () => {
    await expect(
      prisma.inTenant(tenantA, async (tx) => {
        await settings.set(tx, 'notification.sender', { name: 'Lost', email: 'lost@example.test' });
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');

    await expect(
      prisma.inTenant(tenantA, (tx) => settings.get(tx, 'notification.sender')),
    ).resolves.toEqual({ name: 'Ops 2', email: 'ops2@example.test' });
  });
});
