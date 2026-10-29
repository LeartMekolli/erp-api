import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { CampaignsService } from '../src/modules/payments/credits/campaigns.service';
import { campaignListResponseSchema, campaignResponseSchema } from '../src/modules/payments/credits/credit-response';
import { CreditsService } from '../src/modules/payments/credits/credits.service';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { sendEvent } from './payment-webhooks';
import { startTestWorker } from './worker-harness';

const PASSWORD = 'a-long-customer-password';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};

/** The real jobs, with a tiny backoff so a retry happens within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'payments.event': { ...JOBS['payments.event'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

interface CampaignBody {
  id: string;
  status: string;
  granted_customers: number;
  granted_credits: number;
  spent_credits: number;
  budget_left: number;
}

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return {
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
  };
}

/** Campaigns give credits automatically, within a budget (Payments 2 plan, Task 8). */
describe('payments: campaigns', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakePaymentProvider;
  let campaigns: CampaignsService;
  let credits: CreditsService;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JOB_REGISTRY)
      .useValue(fixture)
      .overrideProvider(IDENTITY_NOTIFIER)
      .useValue(notifier)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    fake = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
    campaigns = app.get(CampaignsService);
    credits = app.get(CreditsService);
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  /** Payment keys and Pro, published, giving no monthly credits of its own; staff, and a member. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    await staff.put('/payments/account', KEYS).expect(200);
    const pro = ((await staff.post('/payments/plans', { key: 'pro', name: 'Pro', position: 1, monthly_price: '29.00', yearly_price: '290.00' }).expect(201))
      .body as { id: string }).id;
    return { id: tenant.id, staff, member: clientFor(app, (await tokens.issueForUser(tenant.id, member.id)).accessToken), pro };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const customer = async (w: Workspace, name: string) =>
    ((await w.staff.post('/customers', { name }).expect(201)).body as { id: string }).id;

  /** A customer whose owner subscribes to Pro through the provider, as a customer would. */
  async function subscribedToPro(w: Workspace, name: string) {
    const id = await customer(w, name);
    const email = `owner-${newId()}@campaigns.example.test`;
    await w.staff.post(`/customers/${id}/invitations`, { email, role: 'owner' }).expect(201);
    await request(app.getHttpServer())
      .post('/auth/customer-invitations/accept')
      .send({ token: notifier.lastCustomerInvitationFor(email)!.token, name, password: PASSWORD })
      .expect(204);
    const user = await prisma.inTenant(w.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
    const owner = clientFor(app, (await tokens.issueForUser(w.id, user.id)).accessToken);
    const asked = await owner.post(`/portal/customers/${id}/subscription/checkout`, { plan_id: w.pro, interval: 'month' }).expect(200);
    const checkoutId = (asked.body as { url: string }).url.split('/').at(-1)!;
    const { subscriptionId } = fake.completeSubscriptionCheckout(checkoutId);
    await sendEvent(app, w.id, { id: `evt_${newId().replaceAll('-', '')}`, type: 'checkout.session.completed', objectId: checkoutId });
    return { id, subscriptionId };
  }

  /** A customer on Pro without going through the provider: the subscription row as `sync` would write it. */
  async function onPro(w: Workspace, name: string) {
    const id = await customer(w, name);
    await prisma.inTenant(w.id, async (tx) => {
      const price = await tx.planPrice.findFirstOrThrow({ where: { planId: w.pro, interval: 'month', active: true } });
      await tx.customerSubscription.create({
        data: {
          customerId: id,
          providerSubscriptionId: `sub_fixture_${newId()}`,
          planPriceId: price.id,
          status: 'active',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * DAY),
        },
      });
    });
    return id;
  }

  const campaignBody = (w: Workspace, targets: { plan_ids?: string[]; customer_ids?: string[] }, budget = 150) => ({
    name: 'Launch',
    credits_per_customer: 50,
    credit_days: 60,
    starts_at: new Date(Date.now() - HOUR).toISOString(),
    ends_at: new Date(Date.now() + 30 * DAY).toISOString(),
    budget,
    targets: { plan_ids: [], customer_ids: [], ...targets },
  });
  const create = async (w: Workspace, body: object) => ((await w.staff.post('/payments/campaigns', body).expect(201)).body as CampaignBody).id;
  const view = async (w: Workspace, id: string) => (await w.staff.get(`/payments/campaigns/${id}`).expect(200)).body as CampaignBody;
  const campaignCredits = (w: Workspace, customerId: string) =>
    prisma.inTenant(w.id, async (tx) => (await credits.balance(tx, customerId, new Date())).by_source.campaign);
  const grantsOf = (w: Workspace, campaignId: string) =>
    prisma.inTenant(w.id, (tx) => tx.creditGrant.findMany({ where: { campaignId }, orderBy: { id: 'asc' } }));
  const told = (w: Workspace, eventKey: string, subjectId?: string) =>
    prisma.inTenant(w.id, (tx) => tx.notification.findMany({ where: { eventKey, ...(subjectId ? { subjectId } : {}) } }));

  it('gives every targeted customer its credits once on activation, and no one else', async () => {
    const w = await workspace();
    const brightline = await onPro(w, 'Brightline');
    const mira = await customer(w, 'Mira');
    const sol = await customer(w, 'Sol');
    const id = await create(w, campaignBody(w, { plan_ids: [w.pro], customer_ids: [mira] }));
    expect((await view(w, id)).status).toBe('draft');
    expect(await grantsOf(w, id)).toHaveLength(0);

    const activated = await w.staff.post(`/payments/campaigns/${id}/activate`).expect(200);

    expectDocumented(campaignResponseSchema, activated.body);
    expect(activated.body).toMatchObject({ status: 'active', granted_customers: 2, granted_credits: 100, spent_credits: 0, budget_left: 50 });
    expect(await campaignCredits(w, brightline)).toBe(50);
    expect(await campaignCredits(w, mira)).toBe(50);
    expect(await campaignCredits(w, sol)).toBe(0);
    const grant = (await grantsOf(w, id))[0];
    expect(grant.expiresAt.getTime()).toBeGreaterThan(Date.now() + 59 * DAY);
    const notices = await told(w, 'credits.added');
    expect(notices.map((notice) => notice.subjectId).sort()).toEqual([brightline, mira].sort());
    expect(notices[0].payload).toMatchObject({ credits: '50', source: 'campaign' });

    await campaigns.run(w.id);
    await campaigns.run(w.id);
    expect(await grantsOf(w, id)).toHaveLength(2);
    expect(await told(w, 'credits.added')).toHaveLength(2);

    // What was spent from it shows; anyone with payment.read sees it, only plan.write changes it.
    await credits.spend(w.id, brightline, { amount: 20, reason: 'Image', reference: 'campaign-spend' });
    const listed = await w.member.get('/payments/campaigns').expect(200);
    expectDocumented(campaignListResponseSchema, listed.body);
    expect((listed.body as { data: CampaignBody[] }).data[0]).toMatchObject({ id, spent_credits: 20 });
    await w.member.post('/payments/campaigns', campaignBody(w, { plan_ids: [w.pro] })).expect(403);
    await w.member.post(`/payments/campaigns/${id}/pause`).expect(403);
  });

  it('reaches a customer who joins the plan while it runs, until the budget is used, and says so once', async () => {
    const w = await workspace();
    const id = await create(w, campaignBody(w, { plan_ids: [w.pro] }, 100));
    await w.staff.post(`/payments/campaigns/${id}/activate`).expect(200);

    const kai = await subscribedToPro(w, 'Kai');
    expect(await campaignCredits(w, kai.id)).toBe(50);
    const lea = await subscribedToPro(w, 'Lea');
    expect(await campaignCredits(w, lea.id)).toBe(50);
    expect(await told(w, 'campaign.budget_used')).toHaveLength(0);

    const max = await subscribedToPro(w, 'Max');
    await campaigns.run(w.id);
    await campaigns.grantFor(w.id, max.id);

    expect(await campaignCredits(w, max.id)).toBe(0);
    expect(await view(w, id)).toMatchObject({ granted_customers: 2, granted_credits: 100, budget_left: 0 });
    const used = await told(w, 'campaign.budget_used', id);
    expect(used).toHaveLength(1);
    expect(used[0].payload).toMatchObject({ campaign: 'Launch', budget: '100' });
  });

  it('never grants past the budget when two customers ask at once (Review Focus 4)', async () => {
    const w = await workspace();
    const id = await create(w, campaignBody(w, { plan_ids: [w.pro] }, 50));
    await w.staff.post(`/payments/campaigns/${id}/activate`).expect(200);
    const a = await onPro(w, 'Ana');
    const b = await onPro(w, 'Bo');

    await Promise.all([campaigns.grantFor(w.id, a), campaigns.grantFor(w.id, b)]);

    expect(await grantsOf(w, id)).toHaveLength(1);
    expect((await campaignCredits(w, a)) + (await campaignCredits(w, b))).toBe(50);
    expect(await told(w, 'campaign.budget_used', id)).toHaveLength(1);
  });

  it('stops granting when paused or ended, keeping what it gave, and is edited only while not running', async () => {
    const w = await workspace();
    const first = await onPro(w, 'First');
    const id = await create(w, campaignBody(w, { plan_ids: [w.pro] }));
    await w.staff.post(`/payments/campaigns/${id}/activate`).expect(200);
    expect(await campaignCredits(w, first)).toBe(50);

    expect(JSON.stringify((await w.staff.patch(`/payments/campaigns/${id}`, { budget: 500 }).expect(409)).body)).toContain('pause');
    await w.staff.post(`/payments/campaigns/${id}/pause`).expect(200);
    const second = await onPro(w, 'Second');
    await campaigns.grantFor(w.id, second);
    await campaigns.run(w.id);
    expect(await campaignCredits(w, second)).toBe(0);
    expect(await campaignCredits(w, first)).toBe(50);
    expect((await w.staff.patch(`/payments/campaigns/${id}`, { budget: 500 }).expect(200)).body).toMatchObject({ status: 'paused', budget_left: 450 });

    await w.staff.post(`/payments/campaigns/${id}/activate`).expect(200);
    expect(await campaignCredits(w, second)).toBe(50);
    await w.staff.post(`/payments/campaigns/${id}/end`).expect(200);
    const third = await onPro(w, 'Third');
    await campaigns.grantFor(w.id, third);
    expect(await campaignCredits(w, third)).toBe(0);
    await w.staff.post(`/payments/campaigns/${id}/activate`).expect(409);
    await w.staff.patch(`/payments/campaigns/${id}`, { budget: 600 }).expect(409);

    const entries = await prisma.inTenant(w.id, (tx) => tx.auditEntry.count({ where: { action: 'credit_campaign.changed', subjectId: id } }));
    expect(entries).toBeGreaterThanOrEqual(6);
  });

  it('lets a customer that leaves the plan keep what it got', async () => {
    const w = await workspace();
    const { id: kai, subscriptionId } = await subscribedToPro(w, 'Kai');
    const id = await create(w, campaignBody(w, { plan_ids: [w.pro] }));
    await w.staff.post(`/payments/campaigns/${id}/activate`).expect(200);
    expect(await campaignCredits(w, kai)).toBe(50);

    fake.giveUp(subscriptionId);
    await sendEvent(app, w.id, { id: `evt_${newId().replaceAll('-', '')}`, type: 'customer.subscription.deleted', objectId: subscriptionId });

    expect(await campaignCredits(w, kai)).toBe(50);
  });

  it('refuses a campaign without a target, with its end before its start, or a budget below one grant', async () => {
    const w = await workspace();
    const base = campaignBody(w, { plan_ids: [w.pro] });

    for (const bad of [
      { ...base, targets: { plan_ids: [], customer_ids: [] } },
      { ...base, ends_at: base.starts_at },
      { ...base, budget: 49 },
      { ...base, credits_per_customer: 0 },
      { ...base, credit_days: 0 },
    ]) {
      await w.staff.post('/payments/campaigns', bad).expect(400);
    }
    await w.staff.post('/payments/campaigns', { ...base, targets: { plan_ids: [newId()], customer_ids: [] } }).expect(400);
    await w.staff.get(`/payments/campaigns/${newId()}`).expect(404);
  });
});
