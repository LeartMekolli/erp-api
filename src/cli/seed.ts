import { ConflictException } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import type { CreateTenantInput } from '../platform/tenant-input';
import { TenantService } from '../platform/tenant.service';
import { runCli } from './run-cli';

const SEED_TENANTS: CreateTenantInput[] = [
  { name: 'Demo', slug: 'demo', currency: 'EUR', locale: 'en', timezone: 'UTC' },
  // Test traffic lives in its own tenant instead of behind a test flag (ADR 0001).
  { name: 'Sandbox', slug: 'sandbox', currency: 'EUR', locale: 'en', timezone: 'UTC' },
];

/** Idempotent: an existing slug is skipped, any other failure stops the run. */
void runCli(async (app) => {
  if (app.get(ConfigService).get('NODE_ENV') === 'production') {
    throw new Error('Seeding is for development and test databases only.');
  }

  const tenants = app.get(TenantService);

  for (const seed of SEED_TENANTS) {
    try {
      await tenants.create(seed);
      process.stdout.write(`created tenant ${seed.slug}\n`);
    } catch (error) {
      if (!(error instanceof ConflictException)) {
        throw error;
      }
      process.stdout.write(`tenant ${seed.slug} already exists\n`);
    }
  }
});
