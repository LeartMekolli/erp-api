import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog } from '../src/cli/seed-catalog';
import { seedCustomers } from '../src/cli/seed-customers';
import { seedPartners } from '../src/cli/seed-partners';
import { seedPayments } from '../src/cli/seed-payments';
import { seedPricing } from '../src/cli/seed-pricing';
import { seedWorkflows } from '../src/cli/seed-workflows';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { PaymentAccountService } from '../src/modules/payments/payment-account.service';
import { PayoutAccountsService } from '../src/modules/payments/payout-accounts.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'demo-password-123';
const KEYS = {
  secretKey: 'sk_test_51SecretValueAAAA',
  publishableKey: 'pk_test_51PublishableBBBB',
  webhookSecret: 'whsec_paymentsCCCC',
  connectWebhookSecret: 'whsec_connectDDDD',
};

/**
 * The payments demo seed (Payments plan, Task 13): Luna Jewels pays first, Brightline pays later with
 * a limit, and, only with the demo Stripe keys, the workspace's payment account and Northcast's payout
 * account. Idempotent.
 */
describe('payments demo seed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const as = (token: string) => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`),
  });
  const deps = () => ({ prisma, accounts: app.get(PaymentAccountService), payoutAccounts: app.get(PayoutAccountsService) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  async function seededTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await seedCatalog(prisma, tenant.id);
    await seedPricing(prisma, tenant.id);
    await seedWorkflows(prisma, tenant.id);
    await seedCustomers(prisma, tenant.id, { password: PASSWORD });
    await seedPartners(prisma, tenant.id, { password: PASSWORD });
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    return { ...tenant, staff: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken) };
  }
  type Tenant = Awaited<ReturnType<typeof seededTenant>>;

  const customerNamed = (tenant: Tenant, name: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.customer.findFirstOrThrow({ where: { name }, select: { id: true } }));
  const termsOf = async (tenant: Tenant, name: string) =>
    ((await tenant.staff.get(`/customers/${(await customerNamed(tenant, name)).id}`).expect(200)).body as { payment_terms: object }).payment_terms;

  it('sets Luna Jewels to pay first and adds Brightline paying later, once, and skips the keys without them', async () => {
    const tenant = await seededTenant();

    expect(await seedPayments(deps(), tenant.id, null)).toEqual({ account: 0, customers: 1, terms: 2, payoutAccounts: 0 });
    expect(await seedPayments(deps(), tenant.id, null)).toEqual({ account: 0, customers: 0, terms: 0, payoutAccounts: 0 });

    expect(await termsOf(tenant, 'Luna Jewels')).toEqual({ terms: 'pay_first', days_to_pay: 30, credit_limit: null });
    expect(await termsOf(tenant, 'Brightline')).toEqual({ terms: 'pay_later', days_to_pay: 30, credit_limit: '5000.00' });
    expect(await prisma.inTenant(tenant.id, (tx) => tx.customer.count({ where: { name: 'Brightline' } }))).toBe(1);
    // Without keys, payments are not set up, and nothing failed.
    expect((await tenant.staff.get('/payments/account').expect(200)).body).toMatchObject({ configured: false });
    expect(await prisma.inTenant(tenant.id, (tx) => tx.partnerPayoutAccount.count())).toBe(0);
  });

  it("with the demo keys, sets up the workspace's payments and Northcast's payout account, once", async () => {
    const tenant = await seededTenant();

    expect(await seedPayments(deps(), tenant.id, KEYS)).toEqual({ account: 1, customers: 1, terms: 2, payoutAccounts: 1 });
    expect(await seedPayments(deps(), tenant.id, KEYS)).toEqual({ account: 0, customers: 0, terms: 0, payoutAccounts: 0 });

    expect((await tenant.staff.get('/payments/account').expect(200)).body).toMatchObject({
      configured: true,
      publishable_key: KEYS.publishableKey,
      mode: 'test',
    });
    const northcast = await prisma.inTenant(tenant.id, (tx) => tx.partner.findFirstOrThrow({ where: { name: 'Northcast Foundry' } }));
    expect((await tenant.staff.get(`/partners/${northcast.id}/payout-account`).expect(200)).body).toEqual({ state: 'onboarding' });
    expect(await prisma.inTenant(tenant.id, (tx) => tx.partnerPayoutAccount.count())).toBe(1);
  });
});
