import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import type { PaymentEvent } from '../src/generated/prisma/client';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { registerEventHandler } from '../src/modules/payments/payment-events.service';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { webhookAckResponseSchema } from '../src/modules/payments/payment-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { eventBody, postRaw, sendEvent, webhookPath } from './payment-webhooks';
import type { SentEvent } from './payment-webhooks';
import { startTestWorker } from './worker-harness';

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

/** What the test handlers were given, in order. */
const seen: { tenantId: string; event: PaymentEvent }[] = [];
/** The `error` each run of the flaky handler found on the row, by provider event id. */
const flakyRuns = new Map<string, (string | null)[]>();

registerEventHandler('test.recorded', (tenantId, event) => {
  seen.push({ tenantId, event });
  return Promise.resolve();
});

registerEventHandler('test.flaky', (_tenantId, event) => {
  const runs = flakyRuns.get(event.providerEventId) ?? [];
  runs.push(event.error);
  flakyRuns.set(event.providerEventId, runs);
  return runs.length === 1 ? Promise.reject(new Error('the first run fails')) : Promise.resolve();
});

/**
 * Webhook intake (Payments plan, Task 3): verified on the raw body with the endpoint's own secret,
 * stored once by event id, applied once by a job.
 */
describe('payments: webhooks', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakePaymentProvider;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;

  const http = () => request(app.getHttpServer());

  /** A workspace; with `keys`, its payment account is set up through the API. */
  async function workspace(options: { keys?: boolean; status?: string } = {}): Promise<{ id: string }> {
    const tenant = await createTestTenant(prisma, { status: options.status });
    createdTenants.push(tenant.id);
    if (options.keys ?? true) {
      const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
      const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
      await http().put('/payments/account').set('Authorization', `Bearer ${token}`).send(KEYS).expect(200);
    }
    return { id: tenant.id };
  }

  const event = (type = 'test.recorded', extra: Partial<SentEvent> = {}): SentEvent => ({
    id: `evt_${newId().replaceAll('-', '')}`,
    type,
    objectId: `obj_${newId().replaceAll('-', '')}`,
    ...extra,
  });

  const rows = (tenantId: string) => prisma.inTenant(tenantId, (tx) => tx.paymentEvent.findMany());
  const runsOf = (eventId: string) => seen.filter((run) => run.event.providerEventId === eventId);

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    // The API enqueues payments.event, and the backoff is fixed at enqueue time.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JOB_REGISTRY)
      .useValue(fixture)
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

  it('stores a signed event once and applies it once, however often it is sent', async () => {
    const ws = await workspace();
    const sent = event();

    const res = await sendEvent(app, ws.id, sent);
    expectDocumented(webhookAckResponseSchema, res.body);
    await sendEvent(app, ws.id, sent);

    const stored = await rows(ws.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      providerEventId: sent.id,
      type: 'test.recorded',
      objectId: sent.objectId,
      connectedAccountId: null,
      endpoint: 'payments',
      error: null,
    });
    expect(stored[0]?.appliedAt).toBeInstanceOf(Date);
    expect(runsOf(sent.id)).toHaveLength(1);
  });

  it("hands the handler the event's object and connected account as sent, on the connect endpoint", async () => {
    const ws = await workspace();
    const sent = event('test.recorded', { account: 'acct_partner_1' });

    await sendEvent(app, ws.id, sent, 'connect');

    const [run] = runsOf(sent.id);
    expect(run?.tenantId).toBe(ws.id);
    expect(run?.event).toMatchObject({
      objectId: sent.objectId,
      connectedAccountId: 'acct_partner_1',
      endpoint: 'connect',
    });
  });

  it('refuses a bad signature, a body changed after signing and a missing signature, and stores nothing', async () => {
    const ws = await workspace();
    const body = eventBody(event());
    const signature = fake.sign(body, KEYS.webhook_secret);
    const path = webhookPath(ws.id);

    await postRaw(app, path, body, fake.sign(body, 'whsec_someoneElse')).expect(400);
    await postRaw(app, path, body.replace('test.recorded', 'test.recordeD'), signature).expect(400);
    await postRaw(app, path, body).expect(400);
    await postRaw(app, path, body, 'garbage').expect(400);

    expect(await rows(ws.id)).toEqual([]);
  });

  it('refuses a connect event signed with the payments secret', async () => {
    const ws = await workspace();
    const body = eventBody(event('test.recorded', { account: 'acct_partner_1' }));

    await postRaw(app, webhookPath(ws.id, 'connect'), body, fake.sign(body, KEYS.webhook_secret)).expect(400);

    expect(await rows(ws.id)).toEqual([]);
  });

  it('answers 404 for an unknown or suspended workspace and 400 for one without keys', async () => {
    const body = eventBody(event());
    const signature = fake.sign(body, KEYS.webhook_secret);
    // Without keys too, so a 404 here is the suspension and not the missing keys (400).
    const suspended = await workspace({ status: 'suspended', keys: false });
    const keyless = await workspace({ keys: false });

    await postRaw(app, webhookPath(newId()), body, signature).expect(404);
    await postRaw(app, webhookPath(suspended.id), body, signature).expect(404);
    await postRaw(app, webhookPath(keyless.id), body, signature).expect(400);

    expect(await rows(suspended.id)).toEqual([]);
    expect(await rows(keyless.id)).toEqual([]);
  });

  it('marks an event of a type nobody handles as applied, and does nothing else', async () => {
    const ws = await workspace();
    const sent = event('test.nobody_handles_this');

    await sendEvent(app, ws.id, sent);

    expect(await rows(ws.id)).toEqual([expect.objectContaining({ providerEventId: sent.id, error: null })]);
    expect(runsOf(sent.id)).toEqual([]);
  });

  it("records a handler's error on the event, then applies it when the job retries", async () => {
    const ws = await workspace();
    const sent = event('test.flaky');

    await sendEvent(app, ws.id, sent);

    expect(flakyRuns.get(sent.id)).toEqual([null, 'the first run fails']);
    const [row] = await rows(ws.id);
    expect(row?.appliedAt).toBeInstanceOf(Date);
    // Applied in the end, so the earlier failure is cleared.
    expect(row?.error).toBeNull();
  });

  it("keeps one workspace's events apart from another's, even with the same event id", async () => {
    const a = await workspace();
    const b = await workspace();
    const sent = event();

    await sendEvent(app, a.id, sent);
    await sendEvent(app, b.id, sent);

    expect(await rows(a.id)).toHaveLength(1);
    expect(await rows(b.id)).toHaveLength(1);
    expect(runsOf(sent.id).map((run) => run.tenantId).sort()).toEqual([a.id, b.id].sort());
  });
});
