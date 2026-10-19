import { ConflictException } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { PrismaService } from '../database/prisma.service';
import type { CreateTenantInput } from '../platform/tenant-input';
import { TenantService } from '../platform/tenant.service';
import { createPlatformAdmin } from './platform-admins';
import { runCli } from './run-cli';

const SEED_ADMIN = { email: 'admin@example.test', name: 'Platform Admin' };

const SEED_TENANTS: CreateTenantInput[] = [
  {
    name: 'Demo',
    slug: 'demo',
    currency: 'EUR',
    locale: 'en',
    timezone: 'UTC',
    ownerEmail: 'owner@demo.example.test',
  },
  // Test traffic lives in its own tenant instead of behind a test flag (ADR 0001).
  {
    name: 'Sandbox',
    slug: 'sandbox',
    currency: 'EUR',
    locale: 'en',
    timezone: 'UTC',
    ownerEmail: 'owner@sandbox.example.test',
  },
];

/**
 * Idempotent: existing records are skipped, any other failure stops the run.
 * The admin's generated password is printed here, once. The owners'
 * invitations are emailed: queued here, sent by the worker, readable in
 * Mailpit locally.
 */
void runCli(async (app) => {
  if (app.get(ConfigService).get('NODE_ENV') === 'production') {
    throw new Error('Seeding is for development and test databases only.');
  }

  const admin = await createPlatformAdmin(app.get(PrismaService), SEED_ADMIN);
  process.stdout.write(
    admin
      ? `created platform admin ${admin.email} with password ${admin.password}\n`
      : `platform admin ${SEED_ADMIN.email} already exists\n`,
  );

  const tenants = app.get(TenantService);
  for (const seed of SEED_TENANTS) {
    try {
      await tenants.provision(seed, { type: 'system' });
      process.stdout.write(
        `created tenant ${seed.slug}, invitation emailed to ${seed.ownerEmail}` +
          ' (sent by the worker; locally, read it at http://localhost:8025)\n',
      );
    } catch (error) {
      if (!(error instanceof ConflictException)) {
        throw error;
      }
      process.stdout.write(`tenant ${seed.slug} already exists\n`);
    }
  }
});
