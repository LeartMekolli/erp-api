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
import { creditBalanceResponseSchema, creditPackListResponseSchema, creditPackResponseSchema } from '../src/modules/payments/credits/credit-response';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { payLinkResponseSchema } from '../src/modules/payments/payment-response';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { sendEvent } from './payment-webhooks';
import { startTestWorker } from './worker-harness';

const PASSWORD = 'a-long-customer-password';
const DAY = 86_400_000;
const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const PACK = { name: '100 credits', credits: 100, price: '10.00', valid_days: 365 };

/** The real jobs, with a tiny backoff so a retry happens within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'payments.event': { ...JOBS['payments.event'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

interface Balance {
  total: number;
  by_source: Record<string, number>;
  grants: { source: string; remaining: number; expires_at: string }[];
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

/** Credit packs anyone can buy, on any plan (Payments 2 plan, Task 7). */
describe('payments: credit packs', () => {
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

  /** Luna, on the free plan, owned by Anna with Ben as a buyer; staff with `plan.write`, and a member. */
  async function workspace(options: { keys?: boolean } = {}) {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    if (options.keys !== false) await staff.put('/payments/account', KEYS).expect(200);

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const join = async (role: string) => {
      const email = `${role}-${newId()}@packs.example.test`;
      await staff.post(`/customers/${luna}/invitations`, { email, role }).expect(201);
      await request(app.getHttpServer())
        .post('/auth/customer-invitations/accept')
        .send({ token: notifier.lastCustomerInvitationFor(email)!.token, name: role, password: PASSWORD })
        .expect(204);
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      return clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken);
    };

    return {
      id: tenant.id,
      staff,
      member: clientFor(app, (await tokens.issueForUser(tenant.id, member.id)).accessToken),
      luna,
      anna: await join('owner'),
      ben: await join('buyer'),
    };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const send = (w: Workspace, type: string, objectId: string) =>
    sendEvent(app, w.id, { id: `evt_${newId().replaceAll('-', '')}`, type, objectId });
  const buy = (w: Workspace, packId: string) => w.anna.post(`/portal/customers/${w.luna}/credit-packs/${packId}/buy`);
  const checkoutIdOf = (body: unknown) => (body as { url: string }).url.split('/').at(-1)!;
  const balance = async (w: Workspace) => (await w.anna.get(`/portal/customers/${w.luna}/credits`).expect(200)).body as Balance;
  const journals = (w: Workspace, checkoutId: string) =>
    prisma.inTenant(w.id, (tx) => tx.ledgerJournal.findMany({ where: { providerObjectId: checkoutId }, include: { lines: true }, orderBy: { id: 'asc' } }));
  const purchaseOf = (w: Workspace, checkoutId: string) =>
    prisma.inTenant(w.id, (tx) => tx.creditPackPurchase.findFirstOrThrow({ where: { providerCheckoutId: checkoutId } }));
  const added = (w: Workspace) =>
    prisma.inTenant(w.id, (tx) => tx.notification.findMany({ where: { eventKey: 'credits.added', subjectId: w.luna } }));

  it('lets staff with plan.write make packs, and audits them', async () => {
    const w = await workspace();

    await w.member.post('/payments/credit-packs', PACK).expect(403);
    const created = await w.staff.post('/payments/credit-packs', PACK).expect(201);

    expectDocumented(creditPackResponseSchema, created.body);
    expect(created.body).toMatchObject({ name: '100 credits', credits: 100, price: '10.00', currency: 'EUR', valid_days: 365, status: 'active' });
    const id = (created.body as { id: string }).id;
    for (const bad of [{ ...PACK, credits: 0 }, { ...PACK, credits: 2.5 }, { ...PACK, price: '0' }, { ...PACK, valid_days: 0 }]) {
      await w.staff.post('/payments/credit-packs', bad).expect(400);
    }

    await w.member.patch(`/payments/credit-packs/${id}`, { price: '12.00' }).expect(403);
    const changed = await w.staff.patch(`/payments/credit-packs/${id}`, { price: '12.00' }).expect(200);
    expect(changed.body).toMatchObject({ price: '12.00', credits: 100 });

    const listed = await w.member.get('/payments/credit-packs').expect(200);
    expectDocumented(creditPackListResponseSchema, listed.body);
    const entries = await prisma.inTenant(w.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'credit_pack.changed', subjectId: id }, orderBy: { id: 'asc' } }),
    );
    expect(entries).toHaveLength(2);
    expect(entries[1].before).toMatchObject({ price: '10.00' });
    expect(entries[1].after).toMatchObject({ price: '12.00' });
  });

  it('sells a pack on the free plan at the price asked, grants it once and journals it once', async () => {
    const w = await workspace();
    const pack = ((await w.staff.post('/payments/credit-packs', PACK).expect(201)).body as { id: string }).id;

    const listed = await w.ben.get(`/portal/customers/${w.luna}/credit-packs`).expect(200);
    expectDocumented(creditPackListResponseSchema, listed.body);
    expect((listed.body as { data: { id: string }[] }).data.map((candidate) => candidate.id)).toEqual([pack]);

    await w.ben.post(`/portal/customers/${w.luna}/credit-packs/${pack}/buy`).expect(403);
    const bought = await buy(w, pack).expect(200);
    expectDocumented(payLinkResponseSchema, bought.body);
    const checkoutId = checkoutIdOf(bought.body);

    // A new price after the link was made changes nothing for this purchase.
    await w.staff.patch(`/payments/credit-packs/${pack}`, { price: '12.00' }).expect(200);
    fake.completeCheckout(checkoutId);
    const paidAt = Date.now();
    await send(w, 'checkout.session.completed', checkoutId);
    await send(w, 'checkout.session.completed', checkoutId);

    const after = await balance(w);
    expectDocumented(creditBalanceResponseSchema, after);
    expect(after).toMatchObject({ total: 100, by_source: { pack: 100 } });
    const expiresAt = new Date(after.grants[0].expires_at).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(paidAt + 365 * DAY - 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 365 * DAY);

    expect(await purchaseOf(w, checkoutId)).toMatchObject({ status: 'paid', credits: 100, validDays: 365 });
    const posted = await journals(w, checkoutId);
    expect(posted.map((journal) => journal.kind)).toEqual(['pack_billed', 'payment_received', 'provider_fee']);
    for (const journal of posted) {
      expect(journal.lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0)).toFixed(2)).toBe('0.00');
    }
    expect(posted[0].lines.find((line) => line.account === 'credit_sales')!.amount.toFixed(2)).toBe('-10.00');

    const told = await added(w);
    expect(told).toHaveLength(1);
    expect(told[0].payload).toMatchObject({ credits: '100', source: 'pack' });
  });

  it('grants a paid pack whose checkout id was never stored', async () => {
    const w = await workspace();
    const pack = ((await w.staff.post('/payments/credit-packs', PACK).expect(201)).body as { id: string }).id;
    const checkoutId = checkoutIdOf((await buy(w, pack).expect(200)).body);
    // As the buy stopping right after the provider made the checkout leaves it.
    const { id: purchaseId } = await purchaseOf(w, checkoutId);
    await prisma.inTenant(w.id, (tx) => tx.creditPackPurchase.update({ where: { id: purchaseId }, data: { providerCheckoutId: null } }));

    fake.completeCheckout(checkoutId);
    await send(w, 'checkout.session.completed', checkoutId);
    await send(w, 'checkout.session.completed', checkoutId);

    expect(await balance(w)).toMatchObject({ total: 100, by_source: { pack: 100 } });
    expect(await purchaseOf(w, checkoutId)).toMatchObject({ id: purchaseId, status: 'paid' });
    expect((await journals(w, checkoutId)).map((journal) => journal.kind)).toEqual(['pack_billed', 'payment_received', 'provider_fee']);
    expect(await added(w)).toHaveLength(1);
  });

  it('grants nothing for a checkout that expired, and sells no archived pack', async () => {
    const w = await workspace();
    const pack = ((await w.staff.post('/payments/credit-packs', PACK).expect(201)).body as { id: string }).id;

    const checkoutId = checkoutIdOf((await buy(w, pack).expect(200)).body);
    fake.expire(checkoutId);
    await send(w, 'checkout.session.expired', checkoutId);

    expect((await purchaseOf(w, checkoutId)).status).toBe('expired');
    expect((await balance(w)).total).toBe(0);
    expect(await added(w)).toHaveLength(0);

    await w.staff.patch(`/payments/credit-packs/${pack}`, { status: 'archived' }).expect(200);
    expect(((await w.ben.get(`/portal/customers/${w.luna}/credit-packs`).expect(200)).body as { data: unknown[] }).data).toEqual([]);
    await buy(w, pack).expect(409);
    await buy(w, newId()).expect(404);
  });

  it('refuses to sell a pack before the workspace has payment keys', async () => {
    const w = await workspace({ keys: false });
    const pack = ((await w.staff.post('/payments/credit-packs', PACK).expect(201)).body as { id: string }).id;

    expect(JSON.stringify((await buy(w, pack).expect(409)).body)).toContain('not set up');
  });
});
