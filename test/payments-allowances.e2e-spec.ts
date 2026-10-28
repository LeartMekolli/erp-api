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
import { AllowancesService } from '../src/modules/payments/credits/allowances.service';
import { CreditsService } from '../src/modules/payments/credits/credits.service';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { sendEvent } from './payment-webhooks';
import { startTestWorker } from './worker-harness';

const PASSWORD = 'a-long-customer-password';
const HOUR = 3_600_000;
const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const plan = (key: string, name: string, position: number, monthly: string, yearly: string, monthly_credits: number) => ({
  key,
  name,
  position,
  monthly_price: monthly,
  yearly_price: yearly,
  monthly_credits,
});

/** The real jobs, with a tiny backoff so a retry happens within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'payments.event': { ...JOBS['payments.event'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return {
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
  };
}

/** `from` plus `months`, on the same day or the month's last when it is shorter, as the provider counts. */
function plusMonths(from: Date, months: number): Date {
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), last));
  target.setUTCHours(from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds());
  return target;
}

/** The first moment of the calendar month after `at`, in UTC (the test workspace's time zone). */
const nextCalendarMonth = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));

/** Monthly allowances follow the plan (Payments 2 plan, Task 6). */
describe('payments: monthly allowances', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakePaymentProvider;
  let allowances: AllowancesService;
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
    allowances = app.get(AllowancesService);
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

  /** Payment keys; Starter at 10 credits a month, Pro at 100 and Business at 400. Luna, owned by Anna. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    await staff.put('/payments/account', KEYS).expect(200);
    const plans = (await staff.get('/payments/plans').expect(200)).body as { data: { id: string; is_default: boolean }[] };
    const starter = plans.data.find((candidate) => candidate.is_default)!.id;
    await staff.patch(`/payments/plans/${starter}`, { monthly_credits: 10 }).expect(200);
    const pro = ((await staff.post('/payments/plans', plan('pro', 'Pro', 1, '29.00', '290.00', 100)).expect(201)).body as { id: string }).id;
    const business = ((await staff.post('/payments/plans', plan('business', 'Business', 2, '99.00', '990.00', 400)).expect(201)).body as {
      id: string;
    }).id;

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const email = `anna-${newId()}@allowances.example.test`;
    await staff.post(`/customers/${luna}/invitations`, { email, role: 'owner' }).expect(201);
    await request(app.getHttpServer())
      .post('/auth/customer-invitations/accept')
      .send({ token: notifier.lastCustomerInvitationFor(email)!.token, name: 'Anna', password: PASSWORD })
      .expect(204);
    const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
    const anna = clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken);

    return { id: tenant.id, staff, starter, pro, business, luna, anna };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const send = (w: Workspace, type: string, objectId: string) =>
    sendEvent(app, w.id, { id: `evt_${newId().replaceAll('-', '')}`, type, objectId });
  /** The allowance job, for this workspace alone, as if it ran at `at`. */
  const runJob = (w: Workspace, at = new Date()) => allowances.grantDueInWorkspace(w.id, at);
  const balance = (w: Workspace, at = new Date()) => prisma.inTenant(w.id, (tx) => credits.balance(tx, w.luna, at));
  const allowanceGrants = (w: Workspace) =>
    prisma.inTenant(w.id, (tx) => tx.creditGrant.findMany({ where: { customerId: w.luna, source: 'allowance' }, orderBy: { id: 'asc' } }));
  const expired = (w: Workspace) =>
    prisma.inTenant(w.id, (tx) => tx.creditEntry.findMany({ where: { customerId: w.luna, kind: 'expire' }, orderBy: { id: 'asc' } }));

  /** Luna subscribes at the provider, and the provider tells us. */
  async function subscribe(w: Workspace, planId: string, interval = 'month') {
    const asked = await w.anna.post(`/portal/customers/${w.luna}/subscription/checkout`, { plan_id: planId, interval }).expect(200);
    const checkoutId = (asked.body as { url: string }).url.split('/').at(-1)!;
    const { subscriptionId, invoiceId } = fake.completeSubscriptionCheckout(checkoutId);
    await send(w, 'checkout.session.completed', checkoutId);
    await send(w, 'invoice.paid', invoiceId);
    return { subscriptionId, invoiceId };
  }
  /** The next period starts at the provider and its invoice is told to us. */
  async function renew(w: Workspace, subscriptionId: string, paid: boolean) {
    const { invoiceId } = fake.renew(subscriptionId, paid);
    await send(w, paid ? 'invoice.paid' : 'invoice.payment_failed', invoiceId!);
    await send(w, 'customer.subscription.updated', subscriptionId);
    return invoiceId!;
  }

  it('gives a free customer its credits once a month, however often the job runs', async () => {
    const w = await workspace();

    await runJob(w);
    await runJob(w);

    expect(await balance(w)).toMatchObject({ total: 10, by_source: { allowance: 10 } });
    const [first] = await allowanceGrants(w);
    expect(first.expiresAt).toEqual(nextCalendarMonth(new Date()));

    const next = new Date(nextCalendarMonth(new Date()).getTime() + HOUR);
    await runJob(w, next);
    await runJob(w, next);

    expect(await allowanceGrants(w)).toHaveLength(2);
    // Last month's credits are gone by then; this month's 10 are there.
    expect((await balance(w, next)).total).toBe(10);
  });

  it("swaps the free credits for the paid plan's when the customer subscribes", async () => {
    const w = await workspace();
    await runJob(w);

    const { subscriptionId } = await subscribe(w, w.pro);

    expect(await balance(w)).toMatchObject({ total: 100, by_source: { allowance: 100 } });
    expect((await expired(w)).map((entry) => entry.amount)).toEqual([-10]);
    const grants = await allowanceGrants(w);
    expect(grants.map((grant) => grant.amount)).toEqual([10, 100]);
    expect(grants[1].expiresAt).toEqual(fake.subscription(subscriptionId).currentPeriodEnd);

    await runJob(w);
    expect(await allowanceGrants(w)).toHaveLength(2);
  });

  it('tops up the difference on an upgrade, for the rest of the month', async () => {
    const w = await workspace();
    const { subscriptionId } = await subscribe(w, w.pro);
    await credits.spend(w.id, w.luna, { amount: 30, reason: 'Image', reference: 'before-upgrade' });

    await w.anna.post(`/portal/customers/${w.luna}/subscription/change`, { plan_id: w.business, interval: 'month' }).expect(202);
    const { invoiceId } = fake.settleUpgrade(subscriptionId, true);
    await send(w, 'customer.subscription.updated', subscriptionId);
    await send(w, 'invoice.paid', invoiceId);
    await send(w, 'invoice.paid', invoiceId);

    const grants = await allowanceGrants(w);
    expect(grants.map((grant) => grant.amount)).toEqual([100, 300]);
    expect(grants[1].expiresAt).toEqual(grants[0].expiresAt);
    expect(grants[1].sourceKey).toMatch(/^topup:/);
    expect(await balance(w)).toMatchObject({ total: 370, by_source: { allowance: 370 } });
  });

  it('gives a new month at each paid renewal, and nothing new while the payment is late', async () => {
    const w = await workspace();
    const { subscriptionId } = await subscribe(w, w.pro);
    const secondMonth = new Date(fake.subscription(subscriptionId).currentPeriodEnd.getTime() + HOUR);

    await renew(w, subscriptionId, true);
    expect((await allowanceGrants(w)).map((grant) => grant.amount)).toEqual([100, 100]);
    // Last month's leftover is gone in the new month; the new 100 are there.
    expect((await balance(w, secondMonth)).total).toBe(100);

    const thirdMonth = new Date(fake.subscription(subscriptionId).currentPeriodEnd.getTime() + HOUR);
    const late = await renew(w, subscriptionId, false);
    await runJob(w, thirdMonth);
    expect(await allowanceGrants(w)).toHaveLength(2);
    expect((await balance(w, thirdMonth)).total).toBe(0);

    // Paid after all: the month's allowance arrives then.
    fake.payInvoice(late);
    fake.setSubscriptionStatus(subscriptionId, 'active');
    await send(w, 'invoice.paid', late);
    expect(await allowanceGrants(w)).toHaveLength(3);
    expect((await balance(w, thirdMonth)).total).toBe(100);
  });

  it("gives the plan's new number of credits from the next month on", async () => {
    const w = await workspace();
    const { subscriptionId } = await subscribe(w, w.pro);

    await w.staff.patch(`/payments/plans/${w.pro}`, { monthly_credits: 80 }).expect(200);
    expect((await balance(w)).total).toBe(100);

    await renew(w, subscriptionId, true);
    expect((await allowanceGrants(w)).map((grant) => grant.amount)).toEqual([100, 80]);
  });

  it("swaps the paid credits for the free plan's when the subscription ends", async () => {
    const w = await workspace();
    const { subscriptionId } = await subscribe(w, w.pro);
    await credits.spend(w.id, w.luna, { amount: 40, reason: 'Image', reference: 'before-end' });

    fake.giveUp(subscriptionId);
    await send(w, 'customer.subscription.deleted', subscriptionId);

    expect((await expired(w)).map((entry) => entry.amount)).toEqual([-60]);
    expect(await balance(w)).toMatchObject({ total: 10, by_source: { allowance: 10 } });
    await runJob(w);
    expect((await allowanceGrants(w)).map((grant) => grant.amount)).toEqual([100, 10]);
  });

  it('gives a yearly subscriber each month from the job, never two in one month', async () => {
    const w = await workspace();
    const { subscriptionId } = await subscribe(w, w.pro, 'year');
    const start = fake.subscription(subscriptionId).currentPeriodStart;
    const inMonth = (n: number) => new Date(plusMonths(start, n).getTime() + HOUR);

    await runJob(w);
    expect(await allowanceGrants(w)).toHaveLength(1);

    await runJob(w, inMonth(1));
    await runJob(w, inMonth(1));
    await runJob(w, inMonth(2));

    const grants = await allowanceGrants(w);
    expect(grants.map((grant) => grant.amount)).toEqual([100, 100, 100]);
    expect(new Set(grants.map((grant) => grant.expiresAt.toISOString())).size).toBe(3);
    expect((await balance(w, inMonth(2))).total).toBe(100);
  });
});
