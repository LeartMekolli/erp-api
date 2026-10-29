import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog } from '../src/cli/seed-catalog';
import { seedCustomers } from '../src/cli/seed-customers';
import { seedPartners } from '../src/cli/seed-partners';
import { seedPayments } from '../src/cli/seed-payments';
import { seedPlans } from '../src/cli/seed-plans';
import { seedPricing } from '../src/cli/seed-pricing';
import { seedWorkflows } from '../src/cli/seed-workflows';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { CampaignsService } from '../src/modules/payments/credits/campaigns.service';
import { CreditPacksService } from '../src/modules/payments/credits/credit-packs.service';
import { PaymentAccountService } from '../src/modules/payments/payment-account.service';
import { PayoutAccountsService } from '../src/modules/payments/payout-accounts.service';
import { PlansService } from '../src/modules/payments/plans/plans.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'demo-password-123';
const KEYS = {
  secretKey: 'sk_test_51SecretValueAAAA',
  publishableKey: 'pk_test_51PublishableBBBB',
  webhookSecret: 'whsec_paymentsCCCC',
  connectWebhookSecret: 'whsec_connectDDDD',
};

interface PlanBody {
  id: string;
  key: string;
  is_default: boolean;
  monthly_price: string | null;
  yearly_price: string | null;
  discount_percent: string;
  monthly_credits: number;
  member_limit: number | null;
  features: string[];
  speeds: { key: string; surcharge_percent: string | null }[];
  published: boolean;
}

/**
 * The plans demo seed (Payments 2 plan, Task 9): Starter with trial credits and limits, Pro and
 * Business, two packs and the "Welcome to Pro" campaign; published only with the demo Stripe keys.
 * Idempotent.
 */
describe('plans and credits demo seed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const as = (token: string) => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`),
    patch: (path: string, body: object) => request(app.getHttpServer()).patch(path).set('Authorization', `Bearer ${token}`).send(body),
  });
  const paymentDeps = () => ({ prisma, accounts: app.get(PaymentAccountService), payoutAccounts: app.get(PayoutAccountsService) });
  const planDeps = () => ({ prisma, plans: app.get(PlansService), packs: app.get(CreditPacksService), campaigns: app.get(CampaignsService) });

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

  async function seededTenant(keys: typeof KEYS | null) {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await seedCatalog(prisma, tenant.id);
    await seedPricing(prisma, tenant.id);
    await seedWorkflows(prisma, tenant.id);
    await seedCustomers(prisma, tenant.id, { password: PASSWORD });
    await seedPartners(prisma, tenant.id, { password: PASSWORD });
    await seedPayments(paymentDeps(), tenant.id, keys);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    return { ...tenant, ownerId: owner.id, staff: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken) };
  }
  type Tenant = Awaited<ReturnType<typeof seededTenant>>;

  const plansOf = async (tenant: Tenant) => ((await tenant.staff.get('/payments/plans').expect(200)).body as { data: PlanBody[] }).data;
  const planKeyed = async (tenant: Tenant, key: string) => (await plansOf(tenant)).find((plan) => plan.key === key)!;
  const speedsOf = (plan: PlanBody) => Object.fromEntries(plan.speeds.map((speed) => [speed.key, speed.surcharge_percent]));

  it('sets up Starter, Pro, Business, two packs and an active campaign, once, unpublished without keys', async () => {
    const tenant = await seededTenant(null);

    expect(await seedPlans(planDeps(), tenant.id, tenant.ownerId)).toEqual({ starter: 1, plans: 2, packs: 2, campaigns: 1 });
    expect(await seedPlans(planDeps(), tenant.id, tenant.ownerId)).toEqual({ starter: 0, plans: 0, packs: 0, campaigns: 0 });

    const plans = await plansOf(tenant);
    expect(plans.map((plan) => [plan.key, plan.is_default])).toEqual([
      ['starter', true],
      ['pro', false],
      ['business', false],
    ]);
    const [starter, pro, business] = plans;
    expect(starter).toMatchObject({ monthly_price: null, discount_percent: '0', monthly_credits: 10, member_limit: 2, features: [] });
    expect(pro).toMatchObject({
      monthly_price: '29.00',
      yearly_price: '290.00',
      discount_percent: '5',
      monthly_credits: 100,
      member_limit: 5,
      features: ['progress_emails'],
      published: false,
    });
    // Standard, the default speed, comes with every plan without being listed.
    expect(speedsOf(pro)).toEqual({ express: null });
    expect(business).toMatchObject({
      monthly_price: '99.00',
      yearly_price: '990.00',
      discount_percent: '10',
      monthly_credits: 400,
      member_limit: null,
      features: ['progress_emails', 'pay_later'],
      published: false,
    });
    // Rush at the speed's 30 % less 10 points.
    expect(speedsOf(business)).toEqual({ express: null, rush: '20' });

    const packs = ((await tenant.staff.get('/payments/credit-packs').expect(200)).body as { data: object[] }).data;
    expect(packs).toEqual([
      expect.objectContaining({ credits: 100, price: '10.00', valid_days: 365, status: 'active' }),
      expect.objectContaining({ credits: 500, price: '40.00', valid_days: 365, status: 'active' }),
    ]);

    const campaigns = ((await tenant.staff.get('/payments/campaigns').expect(200)).body as { data: object[] }).data;
    expect(campaigns).toEqual([
      expect.objectContaining({
        name: 'Welcome to Pro',
        status: 'active',
        credits_per_customer: 50,
        credit_days: 60,
        budget: 5000,
        targets: { plan_ids: [pro.id], customer_ids: [] },
      }),
    ]);

    // Brightline was set to pay later before Starter lost pay later, and keeps its terms.
    const brightline = await prisma.inTenant(tenant.id, (tx) => tx.customer.findFirstOrThrow({ where: { name: 'Brightline' } }));
    expect(((await tenant.staff.get(`/customers/${brightline.id}`).expect(200)).body as { payment_terms: object }).payment_terms).toMatchObject({
      terms: 'pay_later',
    });
  });

  it('with the demo keys, publishes the plans, and leaves a Starter staff have already changed', async () => {
    const tenant = await seededTenant(KEYS);
    const starter = await planKeyed(tenant, 'starter');
    await tenant.staff.patch(`/payments/plans/${starter.id}`, { monthly_credits: 25 }).expect(200);

    expect(await seedPlans(planDeps(), tenant.id, tenant.ownerId)).toEqual({ starter: 0, plans: 2, packs: 2, campaigns: 1 });

    expect(await planKeyed(tenant, 'starter')).toMatchObject({ monthly_credits: 25, member_limit: null, features: ['pay_later'] });
    expect(await planKeyed(tenant, 'pro')).toMatchObject({ published: true });
    expect(await planKeyed(tenant, 'business')).toMatchObject({ published: true });
  });
});
