import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ZodError } from 'zod';
import { ConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { PlatformModule } from '../src/platform/platform.module';
import { TenantService } from '../src/platform/tenant.service';
import { CapturingIdentityNotifier } from './capturing-notifier';

/** The service as the CLI and seed use it: no HTTP, no Redis. */
describe('tenant provisioning service', () => {
  let prisma: PrismaService;
  let tenants: TenantService;
  const slug = `test-${Date.now().toString(36)}`;
  const input = {
    name: 'Test',
    slug,
    currency: 'EUR',
    locale: 'en',
    timezone: 'UTC',
    ownerEmail: 'owner@example.test',
  };
  const system = { type: 'system' } as const;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule, PlatformModule],
    })
      .overrideProvider(IDENTITY_NOTIFIER)
      .useValue(new CapturingIdentityNotifier())
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    tenants = moduleRef.get(TenantService);
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: slug } } });
    await prisma.$disconnect();
  });

  it('creates a tenant with a v7 id', async () => {
    const created = await tenants.provision(input, system);

    expect(created.slug).toBe(slug);
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    await expect(prisma.tenant.findUniqueOrThrow({ where: { slug } })).resolves.toMatchObject({
      defaultCurrency: 'EUR',
      defaultLocale: 'en',
      timezone: 'UTC',
    });
  });

  it('refuses a duplicate slug with a conflict', async () => {
    await expect(tenants.provision({ ...input, name: 'Again' }, system)).rejects.toThrow(ConflictException);
  });

  it('refuses invalid input before writing anything', async () => {
    const badSlug = `${slug}-bad`;

    await expect(tenants.provision({ ...input, slug: badSlug, currency: 'EURO' }, system)).rejects.toThrow(
      ZodError,
    );
    await expect(prisma.tenant.count({ where: { slug: badSlug } })).resolves.toBe(0);
  });
});
