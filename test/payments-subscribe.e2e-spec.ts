import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { payLinkResponseSchema } from '../src/modules/payments/payment-response';
import { planOf } from '../src/modules/payments/plans/plan-of';
import { planResponseSchema, portalPlanListResponseSchema, subscriptionResponseSchema } from '../src/modules/payments/plans/plan-response';
import { SubscriptionsService } from '../src/modules/payments/plans/subscriptions.service';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { sendEvent } from './payment-webhooks';
import { pricedCastPart } from './pricing-fixtures';
import { startTestWorker } from './worker-harness';

const PASSWORD = 'a-long-customer-password';
const NO_KEYS = { secretKey: 'unused' };
const d = (value: string) => new Prisma.Decimal(value);
const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const PRO = {
  key: 'pro',
  name: 'Pro',
  position: 1,
  monthly_price: '29.00',
  yearly_price: '290.00',
  discount_percent: '5',
  monthly_credits: 100,
  member_limit: 5,
  features: ['progress_emails'],
  speeds: [{ key: 'express', surcharge_percent: '15' }],
};

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

/** Customers subscribe to a plan through the provider (Payments 2 plan, Task 4). */
describe('payments: subscribing to a plan', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakePaymentProvider;
  let subscriptions: SubscriptionsService;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

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
    subscriptions = app.get(SubscriptionsService);
    // The worker applies the webhooks with its own provider instance, which sees what the app's saw.
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
   * The priced cast part, published, with speeds standard (default), rush and express; the workspace's
   * payment keys; Pro, published. Luna, in the trade group (−10 %), owned by Anna, with Ben as a buyer.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const setup = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${setup.productId}`, { published: true }).expect(200);
    await staff.post('/pricing/delivery-speeds', { key: 'express', name: 'Express', surcharge_percent: '25' }).expect(201);
    await staff.put('/payments/account', KEYS).expect(200);
    const pro = (await staff.post('/payments/plans', PRO).expect(201)).body as { id: string; published: boolean };
    expect(pro.published).toBe(true);

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels', customer_group_id: setup.tradeGroupId }).expect(201)).body as {
      id: string;
    }).id;
    const join = async (role: string) => {
      const email = `${role}-${newId()}@subscribe.example.test`;
      await staff.post(`/customers/${luna}/invitations`, { email, role }).expect(201);
      await request(app.getHttpServer())
        .post('/auth/customer-invitations/accept')
        .send({ token: notifier.lastCustomerInvitationFor(email)!.token, name: role, password: PASSWORD })
        .expect(204);
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      return { id: user.id, client: clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken) };
    };
    const anna = await join('owner');
    const ben = await join('buyer');
    const lunaVersion = (await measuredDesign(prisma, tenant.id, anna.id, { customerId: luna })).versionId;

    return { id: tenant.id, staff, setup, pro: pro.id, luna, anna: anna.client, ben: ben.client, lunaVersion };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const event = (type: string, objectId: string) => ({ id: `evt_${newId().replaceAll('-', '')}`, type, objectId });
  const checkoutIdOf = (url: string) => url.split('/').at(-1)!;
  const ask = (w: Workspace, body: object = { plan_id: w.pro, interval: 'month' }) =>
    w.anna.post(`/portal/customers/${w.luna}/subscription/checkout`, body);
  const subscriptionRow = (w: Workspace) =>
    prisma.inTenant(w.id, (tx) => tx.customerSubscription.findFirst({ where: { customerId: w.luna } }));
  const started = (w: Workspace) =>
    prisma.inTenant(w.id, (tx) => tx.notification.count({ where: { eventKey: 'subscription.started', subjectId: w.luna } }));
  const changed = (w: Workspace) =>
    prisma.inTenant(w.id, (tx) => tx.notification.count({ where: { eventKey: 'subscription.changed', subjectId: w.luna } }));
  const invoiceJournals = (w: Workspace, invoiceId: string) =>
    prisma.inTenant(w.id, (tx) =>
      tx.ledgerJournal.findMany({ where: { providerObjectId: invoiceId }, include: { lines: true }, orderBy: { id: 'asc' } }),
    );

  /** Anna buys Pro monthly at the provider; nothing is told to us yet. */
  async function buyPro(w: Workspace) {
    const asked = await ask(w).expect(200);
    const checkoutId = checkoutIdOf((asked.body as { url: string }).url);
    return { checkoutId, ...fake.completeSubscriptionCheckout(checkoutId) };
  }

  it('shows the customer the plans it can choose, its own marked', async () => {
    const w = await workspace();

    const listed = await w.ben.get(`/portal/customers/${w.luna}/plans`).expect(200);

    expectDocumented(portalPlanListResponseSchema, listed.body);
    const plans = (listed.body as { data: { key: string; current: boolean; monthly_price: string | null }[] }).data;
    expect(plans.map((plan) => [plan.key, plan.current, plan.monthly_price])).toEqual([
      ['starter', true, null],
      ['pro', false, '29.00'],
    ]);
    expect(JSON.stringify(listed.body)).not.toContain('fake_');

    const free = await w.anna.get(`/portal/customers/${w.luna}/subscription`).expect(200);
    expectDocumented(subscriptionResponseSchema, free.body);
    expect(free.body).toEqual({
      plan: { key: 'starter', name: 'Starter' },
      interval: null,
      price: null,
      status: 'free',
      current_period_end: null,
      change: null,
      cancel_at_period_end: false,
    });
  });

  it('subscribes the owner through a checkout, journals the first invoice and tells the customer once', async () => {
    const w = await workspace();

    await w.ben.post(`/portal/customers/${w.luna}/subscription/checkout`, { plan_id: w.pro, interval: 'month' }).expect(403);
    const first = await ask(w).expect(200);
    expectDocumented(payLinkResponseSchema, first.body);
    // A tab closed without paying mustn't block: asking again gives a new link.
    const second = await ask(w).expect(200);
    expect((second.body as { url: string }).url).not.toBe((first.body as { url: string }).url);

    const checkoutId = checkoutIdOf((second.body as { url: string }).url);
    const { subscriptionId, invoiceId } = fake.completeSubscriptionCheckout(checkoutId);
    await sendEvent(app, w.id, event('checkout.session.completed', checkoutId));
    await sendEvent(app, w.id, event('customer.subscription.created', subscriptionId));
    await sendEvent(app, w.id, event('invoice.paid', invoiceId));

    const provider = fake.subscription(subscriptionId);
    const expected = {
      plan: { key: 'pro', name: 'Pro' },
      interval: 'month',
      price: '29.00',
      status: 'active',
      current_period_end: provider.currentPeriodEnd.toISOString(),
      change: null,
      cancel_at_period_end: false,
    };
    const own = await w.anna.get(`/portal/customers/${w.luna}/subscription`).expect(200);
    expectDocumented(subscriptionResponseSchema, own.body);
    expect(own.body).toEqual(expected);
    const staffView = await w.staff.get(`/payments/customers/${w.luna}/subscription`).expect(200);
    expectDocumented(subscriptionResponseSchema, staffView.body);
    expect(staffView.body).toEqual(expected);
    expect((await prisma.inTenant(w.id, (tx) => planOf(tx, w.luna))).key).toBe('pro');

    // Billed, paid and the provider's fee, each balanced.
    const posted = await invoiceJournals(w, invoiceId);
    expect(posted.map((journal) => journal.kind)).toEqual(['plan_billed', 'payment_received', 'provider_fee']);
    for (const journal of posted) {
      expect(journal.lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0)).toFixed(2)).toBe('0.00');
      expect(journal.customerId).toBe(w.luna);
    }
    const billed = posted[0].lines.find((line) => line.account === 'subscription_sales')!;
    expect(billed.amount.toFixed(2)).toBe('-29.00');
    expect(await started(w)).toBe(1);

    // The plan counts its subscriber; the free plan never does.
    const plans = (await w.staff.get('/payments/plans').expect(200)).body as { data: { key: string; subscribers: number }[] };
    expectDocumented(planResponseSchema, plans.data[0]);
    expect(plans.data.map((plan) => [plan.key, plan.subscribers])).toEqual([
      ['starter', 0],
      ['pro', 1],
    ]);
    const choices = (await w.ben.get(`/portal/customers/${w.luna}/plans`).expect(200)).body as { data: { key: string; current: boolean }[] };
    expect(choices.data.find((plan) => plan.current)!.key).toBe('pro');
  });

  it('refuses a second subscription, and links the owner alone to the billing portal', async () => {
    const w = await workspace();
    const plans = (await w.staff.get('/payments/plans').expect(200)).body as { data: { id: string; is_default: boolean }[] };
    const starter = plans.data.find((plan) => plan.is_default)!.id;

    await ask(w, { plan_id: starter, interval: 'month' }).expect(409);
    await ask(w, { plan_id: w.pro, interval: 'week' }).expect(400);
    await ask(w, { plan_id: newId(), interval: 'month' }).expect(404);

    const { checkoutId, subscriptionId } = await buyPro(w);
    await sendEvent(app, w.id, event('checkout.session.completed', checkoutId));
    await sendEvent(app, w.id, event('customer.subscription.created', subscriptionId));

    const again = await ask(w).expect(409);
    expect(JSON.stringify(again.body)).toContain('already');
    const portal = await w.anna.post(`/portal/customers/${w.luna}/billing-portal`).expect(200);
    expectDocumented(payLinkResponseSchema, portal.body);
    expect((portal.body as { url: string }).url).toMatch(/^https:\/\//);
    await w.ben.post(`/portal/customers/${w.luna}/billing-portal`).expect(403);

    // An archived plan sells no more.
    const basic = (await w.staff.post('/payments/plans', { ...PRO, key: 'basic', name: 'Basic' }).expect(201)).body as { id: string };
    await w.staff.post(`/payments/plans/${basic.id}/archive`).expect(200);
    const sol = ((await w.staff.post('/customers', { name: 'Sol Studio' }).expect(201)).body as { id: string }).id;
    const solEmail = `sol-${newId()}@subscribe.example.test`;
    await w.staff.post(`/customers/${sol}/invitations`, { email: solEmail, role: 'owner' }).expect(201);
    await request(app.getHttpServer())
      .post('/auth/customer-invitations/accept')
      .send({ token: notifier.lastCustomerInvitationFor(solEmail)!.token, name: 'Sol', password: PASSWORD })
      .expect(204);
    const solUser = await prisma.inTenant(w.id, (tx) => tx.user.findFirstOrThrow({ where: { email: solEmail } }));
    const solOwner = clientFor(app, (await tokens.issueForUser(w.id, solUser.id)).accessToken);
    await solOwner.post(`/portal/customers/${sol}/subscription/checkout`, { plan_id: basic.id, interval: 'month' }).expect(409);
  });

  it('ends as the provider says now, whatever order the webhooks arrive in (Review Focus 3)', async () => {
    const w = await workspace();
    const { checkoutId, subscriptionId } = await buyPro(w);
    const matchesProvider = async () => {
      const row = await subscriptionRow(w);
      const now = fake.subscription(subscriptionId);
      expect(row).toMatchObject({
        providerSubscriptionId: subscriptionId,
        status: now.status,
        currentPeriodEnd: now.currentPeriodEnd,
        cancelAtPeriodEnd: now.cancelAtPeriodEnd,
      });
    };

    // The update arrives before the checkout.
    await sendEvent(app, w.id, event('customer.subscription.updated', subscriptionId));
    await matchesProvider();
    await sendEvent(app, w.id, event('checkout.session.completed', checkoutId));
    await matchesProvider();

    // A newer state, then an older update delivered late.
    fake.setSubscriptionStatus(subscriptionId, 'past_due');
    await sendEvent(app, w.id, event('customer.subscription.updated', subscriptionId));
    await matchesProvider();
    await sendEvent(app, w.id, event('customer.subscription.created', subscriptionId));
    await matchesProvider();
    expect((await subscriptionRow(w))!.status).toBe('past_due');
    // A customer whose payment is late keeps the plan.
    expect((await prisma.inTenant(w.id, (tx) => planOf(tx, w.luna))).key).toBe('pro');
    expect(await started(w)).toBe(1);
  });

  it('keeps the newer state when an older read commits last (Review Focus 1)', async () => {
    const w = await workspace();
    const { checkoutId, subscriptionId } = await buyPro(w);
    await sendEvent(app, w.id, event('checkout.session.completed', checkoutId));
    const startedBefore = await started(w);
    const changedBefore = await changed(w);

    // Sync A reads the subscription while it is active, then waits before writing.
    const stale = await fake.getSubscription(NO_KEYS, subscriptionId);
    let reached!: () => void;
    const asked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = jest.spyOn(fake, 'getSubscription').mockImplementationOnce(async () => {
      reached();
      await gate;
      return stale;
    });
    const older = subscriptions.sync(w.id, subscriptionId);
    await asked;
    // Read times are kept to the millisecond: B reads at least one later.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Sync B reads the newer state and commits first.
    fake.setSubscriptionStatus(subscriptionId, 'past_due');
    const newerFrom = new Date();
    await subscriptions.sync(w.id, subscriptionId);
    release();
    await older;
    spy.mockRestore();

    const row = await subscriptionRow(w);
    expect(row!.status).toBe('past_due');
    expect(row!.providerReadAt!.getTime()).toBeGreaterThanOrEqual(newerFrom.getTime());
    expect(await started(w)).toBe(startedBefore);
    expect(await changed(w)).toBe(changedBefore);
  });

  it('journals a negative invoice as customer credit and a balance-paid one without cash (Review Focus 3)', async () => {
    const w = await workspace();
    const { checkoutId, subscriptionId, invoiceId } = await buyPro(w);
    await sendEvent(app, w.id, event('checkout.session.completed', checkoutId));
    await sendEvent(app, w.id, event('invoice.paid', invoiceId));

    // A move from a dearer plan mid-period: the provider gives the difference back as the customer's balance…
    const { invoiceId: credited } = fake.issueInvoice(subscriptionId, { total: d('-166.00'), reason: 'update', paid: true });
    await sendEvent(app, w.id, event('invoice.paid', credited));
    await sendEvent(app, w.id, event('invoice.paid', credited));
    // …which pays the next invoice, so no payment is taken.
    const { invoiceId: fromBalance } = fake.issueInvoice(subscriptionId, {
      total: d('99.00'),
      reason: 'cycle',
      paid: true,
      amountPaid: d('0'),
    });
    await sendEvent(app, w.id, event('invoice.paid', fromBalance));
    await sendEvent(app, w.id, event('invoice.paid', fromBalance));

    const creditedJournals = await invoiceJournals(w, credited);
    expect(creditedJournals.map((journal) => journal.kind)).toEqual(['plan_credited']);
    const balanceJournals = await invoiceJournals(w, fromBalance);
    expect(balanceJournals.map((journal) => journal.kind)).toEqual(['plan_billed', 'credit_applied']);
    expect(balanceJournals[1].lines.find((line) => line.account === 'customer_credit')!.amount.toFixed(2)).toBe('99.00');
    for (const journal of [...creditedJournals, ...balanceJournals]) {
      expect(journal.lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0)).toFixed(2)).toBe('0.00');
      expect(journal.customerId).toBe(w.luna);
    }
    const credit = await prisma.inTenant(w.id, (tx) =>
      tx.ledgerLine.aggregate({ _sum: { amount: true }, where: { account: 'customer_credit', customerId: w.luna } }),
    );
    expect(credit._sum.amount!.toFixed(2)).toBe('-67.00');
  });

  it('journals one paid subscription invoice once, and leaves order invoices to their own handler', async () => {
    const w = await workspace();
    const { checkoutId, subscriptionId, invoiceId } = await buyPro(w);
    await sendEvent(app, w.id, event('checkout.session.completed', checkoutId));
    await sendEvent(app, w.id, event('customer.subscription.created', subscriptionId));

    await sendEvent(app, w.id, event('invoice.paid', invoiceId));
    await sendEvent(app, w.id, event('invoice.paid', invoiceId));
    await sendEvent(app, w.id, event('invoice.payment_succeeded', invoiceId));

    expect((await invoiceJournals(w, invoiceId)).map((journal) => journal.kind)).toEqual(['plan_billed', 'payment_received', 'provider_fee']);
    // No order invoice was made for it.
    expect(await prisma.inTenant(w.id, (tx) => tx.invoice.count())).toBe(0);
  });

  it("prices the subscriber's portal quotes with Pro's discount and speeds", async () => {
    const w = await workspace();
    const quote = (delivery_speed: string) =>
      w.anna.post(`/portal/customers/${w.luna}/quotes`, {
        product_id: w.setup.productId,
        options: { material: 'brass', finish: 'raw' },
        size: { scale: '1' },
        file_version_id: w.lunaVersion,
        quantity: 1,
        delivery_speed,
      });
    await quote('express').expect(400);

    const { checkoutId, subscriptionId } = await buyPro(w);
    await sendEvent(app, w.id, event('checkout.session.completed', checkoutId));
    await sendEvent(app, w.id, event('customer.subscription.created', subscriptionId));

    const priced = await quote('express').expect(201);
    const labels = (priced.body as { quote: { lines: { label: string }[] } }).quote.lines.map((line) => line.label);
    expect(labels).toEqual(expect.arrayContaining(['your_discount', 'plan_discount', 'delivery_speed']));
  });
});
