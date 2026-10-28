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
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { planOf } from '../src/modules/payments/plans/plan-of';
import { subscriptionResponseSchema } from '../src/modules/payments/plans/plan-response';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { sendEvent } from './payment-webhooks';
import { startTestWorker } from './worker-harness';

const PASSWORD = 'a-long-customer-password';
const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const plan = (key: string, name: string, position: number, monthly: string, yearly: string) => ({
  key,
  name,
  position,
  monthly_price: monthly,
  yearly_price: yearly,
});

/** The real jobs, with a tiny backoff so a retry happens within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'payments.event': { ...JOBS['payments.event'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

interface SubscriptionBody {
  plan: { key: string; name: string };
  interval: string | null;
  status: string;
  current_period_end: string | null;
  change: { plan: { key: string; name: string }; interval: string | null; on: string } | null;
  cancel_at_period_end: boolean;
}

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return {
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
  };
}

/** Upgrades on payment, downgrades at the period end, and the drop to free (Payments 2 plan, Task 5). */
describe('payments: changing plans and failed payments', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakePaymentProvider;
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
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  /**
   * The workspace's payment keys; Pro at 29.00 a month or 290.00 a year and Business at 99.00 or
   * 990.00, both published. Brightline pays later, owned by Anna, with Ben as a buyer.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    await staff.put('/payments/account', KEYS).expect(200);
    const pro = ((await staff.post('/payments/plans', plan('pro', 'Pro', 1, '29.00', '290.00')).expect(201)).body as { id: string }).id;
    const business = ((await staff.post('/payments/plans', plan('business', 'Business', 2, '99.00', '990.00')).expect(201)).body as {
      id: string;
    }).id;
    const plans = (await staff.get('/payments/plans').expect(200)).body as { data: { id: string; is_default: boolean }[] };
    const starter = plans.data.find((candidate) => candidate.is_default)!.id;

    const brightline = ((await staff.post('/customers', { name: 'Brightline' }).expect(201)).body as { id: string }).id;
    await staff.put(`/customers/${brightline}/payment-terms`, { terms: 'pay_later', days_to_pay: 30, credit_limit: null }).expect(200);
    const join = async (role: string) => {
      const email = `${role}-${newId()}@changes.example.test`;
      await staff.post(`/customers/${brightline}/invitations`, { email, role }).expect(201);
      await request(app.getHttpServer())
        .post('/auth/customer-invitations/accept')
        .send({ token: notifier.lastCustomerInvitationFor(email)!.token, name: role, password: PASSWORD })
        .expect(204);
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      return clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken);
    };

    return { id: tenant.id, staff, pro, business, starter, brightline, anna: await join('owner'), ben: await join('buyer') };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const event = (type: string, objectId: string) => ({ id: `evt_${newId().replaceAll('-', '')}`, type, objectId });
  const send = (w: Workspace, type: string, objectId: string) => sendEvent(app, w.id, event(type, objectId));
  const change = (w: Workspace, plan_id: string, interval = 'month') =>
    w.anna.post(`/portal/customers/${w.brightline}/subscription/change`, { plan_id, interval });
  const subscription = async (w: Workspace) =>
    (await w.anna.get(`/portal/customers/${w.brightline}/subscription`).expect(200)).body as SubscriptionBody;
  const planKey = async (w: Workspace) => (await prisma.inTenant(w.id, (tx) => planOf(tx, w.brightline))).key;
  const told = (w: Workspace, eventKey: string) =>
    prisma.inTenant(w.id, (tx) => tx.notification.findMany({ where: { eventKey, subjectId: w.brightline } }));

  /** Brightline subscribes at the provider, and the provider tells us. */
  async function subscribe(w: Workspace, planId: string, interval = 'month') {
    const asked = await w.anna.post(`/portal/customers/${w.brightline}/subscription/checkout`, { plan_id: planId, interval }).expect(200);
    const checkoutId = (asked.body as { url: string }).url.split('/').at(-1)!;
    const { subscriptionId, invoiceId } = fake.completeSubscriptionCheckout(checkoutId);
    await send(w, 'checkout.session.completed', checkoutId);
    await send(w, 'invoice.paid', invoiceId);
    return subscriptionId;
  }

  it('upgrades at once, but only once the prorated invoice is paid', async () => {
    const w = await workspace();
    const id = await subscribe(w, w.pro);

    await w.ben.post(`/portal/customers/${w.brightline}/subscription/change`, { plan_id: w.business, interval: 'month' }).expect(403);
    const asked = await change(w, w.business).expect(202);

    expectDocumented(subscriptionResponseSchema, asked.body);
    expect((asked.body as SubscriptionBody).plan.key).toBe('pro');
    expect(await planKey(w)).toBe('pro');

    const { invoiceId } = fake.settleUpgrade(id, true);
    await send(w, 'customer.subscription.updated', id);
    await send(w, 'invoice.paid', invoiceId);

    expect(await subscription(w)).toMatchObject({ plan: { key: 'business' }, status: 'active', change: null });
    expect(await planKey(w)).toBe('business');
    expect(await told(w, 'subscription.changed')).toHaveLength(1);
    const billed = await prisma.inTenant(w.id, (tx) => tx.ledgerJournal.findMany({ where: { providerObjectId: invoiceId, kind: 'plan_billed' } }));
    expect(billed).toHaveLength(1);
  });

  it('keeps the old plan when the upgrade is not paid, and says so once (Review Focus 2)', async () => {
    const w = await workspace();
    const id = await subscribe(w, w.pro);

    await change(w, w.business).expect(202);
    const { invoiceId } = fake.settleUpgrade(id, false);
    await send(w, 'invoice.payment_failed', invoiceId);
    await send(w, 'customer.subscription.updated', id);
    await send(w, 'invoice.payment_failed', invoiceId);

    expect(await subscription(w)).toMatchObject({ plan: { key: 'pro' }, status: 'active' });
    expect(await planKey(w)).toBe('pro');
    const failed = await told(w, 'subscription.upgrade_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toMatchObject({ plan: 'Business' });
    expect(await told(w, 'subscription.payment_failed')).toHaveLength(0);
    expect(await told(w, 'subscription.changed')).toHaveLength(0);
  });

  it('downgrades at the period end, and the current plan again takes the change back', async () => {
    const w = await workspace();
    const id = await subscribe(w, w.business);
    const end = fake.subscription(id).currentPeriodEnd.toISOString();

    const asked = await change(w, w.pro).expect(200);

    expectDocumented(subscriptionResponseSchema, asked.body);
    expect(asked.body).toMatchObject({ plan: { key: 'business' }, change: { plan: { key: 'pro', name: 'Pro' }, interval: 'month', on: end } });
    expect(await planKey(w)).toBe('business');
    await send(w, 'customer.subscription.updated', id);
    const scheduled = await told(w, 'subscription.downgrade_scheduled');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].payload).toMatchObject({ plan: 'Pro' });

    expect((await change(w, w.business).expect(200)).body).toMatchObject({ plan: { key: 'business' }, change: null });
    await change(w, w.pro).expect(200);

    const { invoiceId } = fake.renew(id, true);
    await send(w, 'customer.subscription.updated', id);
    await send(w, 'invoice.paid', invoiceId!);

    expect(await subscription(w)).toMatchObject({ plan: { key: 'pro' }, change: null, status: 'active' });
    expect(await planKey(w)).toBe('pro');
    expect(await told(w, 'subscription.changed')).toHaveLength(1);
  });

  it('treats what costs as much or more a month as an upgrade', async () => {
    const w = await workspace();
    await subscribe(w, w.pro, 'year');

    await change(w, w.business, 'month').expect(202);
  });

  it('drops to the free plan at the period end, and tells the customer and staff once', async () => {
    const w = await workspace();
    const id = await subscribe(w, w.pro);
    const end = fake.subscription(id).currentPeriodEnd.toISOString();

    const asked = await change(w, w.starter).expect(200);

    expect(asked.body).toMatchObject({
      plan: { key: 'pro' },
      cancel_at_period_end: true,
      change: { plan: { key: 'starter', name: 'Starter' }, interval: null, on: end },
    });

    expect(fake.renew(id, true)).toEqual({ invoiceId: null });
    await send(w, 'customer.subscription.deleted', id);
    await send(w, 'customer.subscription.deleted', id);

    expect(await subscription(w)).toMatchObject({ plan: { key: 'starter' }, status: 'free', change: null });
    expect(await planKey(w)).toBe('starter');
    expect(await told(w, 'subscription.ended')).toHaveLength(1);
    const staff = await told(w, 'subscription.ended.staff');
    expect(staff).toHaveLength(1);
    expect(staff[0].payload).toMatchObject({ customer: 'Brightline', plan: 'Pro', pay_later: 'yes' });

    // Subscribing again after the end works.
    await subscribe(w, w.pro);
    expect(await planKey(w)).toBe('pro');
  });

  it('keeps the plan while a payment is late, refuses changes, and drops to free when the provider gives up', async () => {
    const w = await workspace();
    const id = await subscribe(w, w.pro);

    const { invoiceId } = fake.renew(id, false);
    await send(w, 'invoice.payment_failed', invoiceId!);
    await send(w, 'customer.subscription.updated', id);
    await send(w, 'invoice.payment_failed', invoiceId!);

    expect(await subscription(w)).toMatchObject({ plan: { key: 'pro' }, status: 'past_due' });
    expect(await planKey(w)).toBe('pro');
    const failed = await told(w, 'subscription.payment_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toMatchObject({ plan: 'Pro', portal_url: expect.stringContaining('/billing') });
    expect(JSON.stringify((await change(w, w.business).expect(409)).body)).toContain('late');

    fake.giveUp(id);
    await send(w, 'customer.subscription.deleted', id);

    expect(await planKey(w)).toBe('starter');
    expect(await told(w, 'subscription.ended')).toHaveLength(1);
  });

  it('refuses a change without a subscription, and to a plan not sold', async () => {
    const w = await workspace();

    expect(JSON.stringify((await change(w, w.pro).expect(409)).body)).toContain('checkout');

    await subscribe(w, w.pro);
    await w.staff.post(`/payments/plans/${w.business}/archive`).expect(200);
    await change(w, w.business).expect(409);
    await change(w, newId()).expect(404);
    await change(w, w.pro, 'week').expect(400);
  });
});
