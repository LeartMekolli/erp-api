import { ConflictException } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { PrismaService } from '../database/prisma.service';
import { PaymentAccountService } from '../modules/payments/payment-account.service';
import { PayoutAccountsService } from '../modules/payments/payout-accounts.service';
import type { CreateTenantInput } from '../platform/tenant-input';
import { TenantService } from '../platform/tenant.service';
import { createPlatformAdmin } from './platform-admins';
import { runCli } from './run-cli';
import { seedCatalog, seedPlaceholderDesign } from './seed-catalog';
import { seedCustomers } from './seed-customers';
import { seedOrders } from './seed-orders';
import { seedPartners } from './seed-partners';
import { seedPayments } from './seed-payments';
import { seedPricing } from './seed-pricing';
import { seedWorkflows } from './seed-workflows';

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
 * The demo workspace also gets the example catalog (`seed-catalog.ts`), its pricing (`seed-pricing.ts`)
 * demo customers (`seed-customers.ts`), demo partners (`seed-partners.ts`), its ordering setup
 * (`seed-orders.ts`) and its payments (`seed-payments.ts`, keys from `DEMO_STRIPE_*`). The admin's, the
 * customer people's and the partner owners' generated passwords are printed here, once. The owners'
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

  // The demo workspace gets an example catalog for made-to-order 3D objects.
  const prisma = app.get(PrismaService);
  const demo = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'demo' }, select: { id: true } });
  // The placeholder design of the demo's ready-made parts is a file, so it has an uploader: a staff user
  // that can't sign in (its password hash matches nothing), since the owner only exists once invited.
  const uploaderEmail = 'catalog@demo.example.test';
  const uploader = await prisma.inTenant(demo.id, async (tx) => {
    const found = await tx.user.findFirst({ where: { email: uploaderEmail } });
    if (found) return found;
    const { defaultLocale } = await tx.tenant.findUniqueOrThrow({ where: { id: demo.id }, select: { defaultLocale: true } });
    return tx.user.create({ data: { email: uploaderEmail, name: 'Demo catalog', passwordHash: '!', locale: defaultLocale, kind: 'staff' } });
  });
  const partVersionId = await seedPlaceholderDesign(prisma, demo.id, uploader.id);
  const created = await seedCatalog(prisma, demo.id, { partVersionId });
  process.stdout.write(
    `catalog for demo: created ${created.categories} categories, ${created.materials} materials, ` +
      `${created.optionGroups} option groups, ${created.optionValues} option values, ${created.optionRules} rules, ` +
      `${created.products} products\n`,
  );

  const pricing = await seedPricing(prisma, demo.id);
  process.stdout.write(
    `pricing for demo: created ${pricing.stepTypes} step types, ${pricing.stepPrices} step prices, ${pricing.chains} chains, ` +
      `${pricing.tiers} discount tiers, ${pricing.groups} customer groups, ${pricing.speeds} delivery speeds\n`,
  );

  const workflows = await seedWorkflows(prisma, demo.id);
  process.stdout.write(
    `workflows for demo: created ${workflows.defects} defects, ${workflows.stepTypes} step types, ${workflows.workflows} workflows\n`,
  );

  const customers = await seedCustomers(prisma, demo.id);
  process.stdout.write(
    `customers for demo: created ${customers.counts.customers} customers, ${customers.counts.people} people` +
      (customers.password ? ` with password ${customers.password} (anna@luna.example.test, ben@luna.example.test, mira@mira.example.test)` : '') +
      '\n',
  );

  const partners = await seedPartners(prisma, demo.id);
  process.stdout.write(
    `partners for demo: created ${partners.counts.partners} partners, ${partners.counts.people} people` +
      (partners.password ? ` with password ${partners.password} (owner@northcast.example.test, owner@layerline.example.test)` : '') +
      '\n',
  );

  const orders = await seedOrders(prisma, demo.id);
  process.stdout.write(
    `orders for demo: created ${orders.shippingMethods} shipping methods, ${orders.taxRates} tax rates` +
      (orders.calendar ? ', the business calendar' : '') +
      (orders.scheduling ? ', the job due dates' : '') +
      '\n',
  );

  const config = app.get(ConfigService);
  const secretKey = config.get('DEMO_STRIPE_SECRET_KEY');
  const keys = secretKey
    ? {
        secretKey,
        publishableKey: config.get('DEMO_STRIPE_PUBLISHABLE_KEY')!,
        webhookSecret: config.get('DEMO_STRIPE_WEBHOOK_SECRET')!,
        connectWebhookSecret: config.get('DEMO_STRIPE_CONNECT_WEBHOOK_SECRET')!,
      }
    : null;
  const payments = await seedPayments(
    { prisma, accounts: app.get(PaymentAccountService), payoutAccounts: app.get(PayoutAccountsService) },
    demo.id,
    keys,
  );
  process.stdout.write(
    `payments for demo: created ${payments.customers} customers, ${payments.terms} payment terms` +
      (keys
        ? `, ${payments.account} payment accounts, ${payments.payoutAccounts} payout accounts\n`
        : '; no DEMO_STRIPE_* keys, so the payment account and payout accounts are skipped\n'),
  );
});
