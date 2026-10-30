import { randomBytes } from 'node:crypto';
import { ConflictException, ForbiddenException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { JobsService } from '../src/jobs/jobs.service';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { customerResultSchema } from '../src/modules/ai/customer-tools/customer-result-response';
import { CUSTOMER_FAILED_MESSAGE } from '../src/modules/ai/customer-tools/customer-tools';
import { CustomerToolsService } from '../src/modules/ai/customer-tools/customer-tools.service';
import { aiRunListResponseSchema } from '../src/modules/ai/run-response';
import { RunsService } from '../src/modules/ai/runs.service';
import type { RunOutcome } from '../src/modules/ai/runs.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import type { CustomerAuth } from '../src/modules/identity/auth-context';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { hashPassword } from '../src/modules/identity/passwords';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

const PASSWORD = 'a-long-customer-password';
const DAY_MS = 86_400_000;

/** The real jobs, with a tiny backoff so a failing run reaches its last attempt within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'ai.run': { ...JOBS['ai.run'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

/** What the test handler writes; the shape Task 3's brand content will have. */
const CONTENT = { names: ['Moonlit'], short: 'A short text.', long: 'A long text.', tags: ['silver'] };

/** One million input tokens on Haiku 4.5: exactly 1.00 USD. */
const done: RunOutcome = {
  status: 'done',
  usage: { inputTokens: 1_000_000, outputTokens: 0 },
  output: CONTENT,
  refs: [],
  error: null,
};

interface Result {
  id: string;
  tool: string;
  status: 'pending' | 'done' | 'failed';
  input: unknown;
  output: unknown;
  credits: number;
  credits_given_back: boolean;
  error: string | null;
  parent_id: string | null;
  file_id: string | null;
  asked_by: { id: string; name: string };
}

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return {
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`),
  };
}
type Client = ReturnType<typeof clientFor>;

/**
 * Customers pay for AI runs in credits, by plan (AI 2 plan, Task 2): the plan switch, the price, the
 * spend and the run in one transaction under the workspace's AI limit; credits back when a run fails;
 * the history, read and deleted by the customer. A test handler stands in for the tool.
 */
describe('ai: customer runs paid in credits', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let tools: CustomerToolsService;
  let runs: RunsService;
  let adminId: string;
  let adminToken: string;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;

  /** How the test handler answers its next runs; `hold` waits until `release` is called. */
  let behaviour: 'done' | 'throw' | 'hold' = 'done';
  let release: () => void = () => undefined;

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
    tools = app.get(CustomerToolsService);
    runs = app.get(RunsService);

    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
    worker.get(CustomerToolsService).onKind('brand_content', async () => {
      if (behaviour === 'throw') throw new Error('the model is down');
      if (behaviour === 'hold') await new Promise<void>((resolve) => (release = resolve));
      return done;
    });

    const admin = await prisma.platformAdmin.create({
      data: { email: `platform-${newId()}@example.test`, passwordHash: await hashPassword('platform-admin-password'), name: 'Platform Admin' },
    });
    adminId = admin.id;
    adminToken = (await tokens.issueForPlatformAdmin(admin.id)).accessToken;
  });

  afterEach(() => {
    behaviour = 'done';
    release();
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await prisma.platformAdmin.delete({ where: { id: adminId } });
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  const setLimit = (tenantId: string, monthlyUsd: string) =>
    request(app.getHttpServer())
      .put(`/platform/tenants/${tenantId}/ai-limit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monthly_usd: monthlyUsd })
      .expect(200);

  /**
   * A workspace with a 20.00 USD AI limit. Luna has `credits` staff-granted credits and three people:
   * Anna (owner), Ben (buyer) and Vic (viewer). Sol, another customer, has its owner Sam.
   */
  async function workspace(credits = 20) {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const staffUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, staffUser.id)).accessToken);
    await setLimit(tenant.id, '20.00');

    const customer = async (name: string) => ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
    const person = async (customerId: string, name: string, role: CustomerAuth['role']) => {
      const email = `${name.toLowerCase()}-${newId()}@ai-tools.example.test`;
      await staff.post(`/customers/${customerId}/invitations`, { email, role }).expect(201);
      await request(app.getHttpServer())
        .post('/auth/customer-invitations/accept')
        .send({ token: notifier.lastCustomerInvitationFor(email)!.token, name, password: PASSWORD })
        .expect(204);
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      const auth: CustomerAuth = { tenantId: tenant.id, userId: user.id, customerId, role };
      return { id: user.id, auth, client: clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken) };
    };

    const luna = await customer('Luna Jewels');
    const sol = await customer('Sol Rings');
    const expiresOn = new Date(Date.now() + 30 * DAY_MS).toISOString().slice(0, 10);
    await staff.post(`/payments/customers/${luna}/credits`, { amount: credits, expires_on: expiresOn, reason: 'AI trial' }).expect(201);

    return {
      tenantId: tenant.id,
      staff,
      luna,
      sol,
      anna: await person(luna, 'Anna', 'owner'),
      ben: await person(luna, 'Ben', 'buyer'),
      vic: await person(luna, 'Vic', 'viewer'),
      sam: await person(sol, 'Sam', 'owner'),
    };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  /** Staff tick brand content on the default plan, which every customer here is on. */
  async function allowBrand(w: Workspace) {
    const plans = (await w.staff.get('/payments/plans').expect(200)).body as { data: { id: string; is_default: boolean; features: string[] }[] };
    const starter = plans.data.find((plan) => plan.is_default)!;
    await w.staff.patch(`/payments/plans/${starter.id}`, { features: [...starter.features, 'ai_brand'] }).expect(200);
  }

  const portal = (customerId: string, rest: string) => `/portal/customers/${customerId}/ai${rest}`;
  const ask = (w: Workspace) => tools.start(w.anna.auth, 'brand_content', { description: 'A silver ring' });
  const balance = async (w: Workspace, client: Client = w.anna.client) =>
    ((await client.get(`/portal/customers/${w.luna}/credits`).expect(200)).body as { total: number }).total;
  const finished = (w: Workspace, id: string) =>
    waitFor(async () => {
      const body = (await w.anna.client.get(portal(w.luna, `/runs/${id}`)).expect(200)).body as Result;
      return body.status === 'pending' ? undefined : body;
    });
  const count = (w: Workspace) =>
    prisma.inTenant(w.tenantId, async (tx) => ({
      runs: await tx.aiRun.count(),
      results: await tx.aiCustomerResult.count(),
      spends: await tx.creditSpend.count({ where: { kind: 'spend' } }),
      givenBack: await tx.creditSpend.count({ where: { kind: 'give_back' } }),
    }));

  it("refuses a tool the customer's plan doesn't include, and charges nothing", async () => {
    const w = await workspace();

    await expect(ask(w)).rejects.toThrow(ForbiddenException);
    await expect(ask(w)).rejects.toThrow("Your plan doesn't include this tool");
    expect(await balance(w)).toBe(20);
    expect(await count(w)).toEqual({ runs: 0, results: 0, spends: 0, givenBack: 0 });
  });

  it('charges the price when the run is queued, and shows the result only to the customer', async () => {
    const w = await workspace();
    await allowBrand(w);

    const { id } = await ask(w);
    const result = await finished(w, id);
    expectDocumented(customerResultSchema, result);
    expect(result).toMatchObject({
      id,
      tool: 'brand_content',
      status: 'done',
      input: { description: 'A silver ring' },
      output: CONTENT,
      credits: 3,
      credits_given_back: false,
      error: null,
      parent_id: null,
      file_id: null,
      asked_by: { id: w.anna.id, name: 'Anna' },
    });
    expect(await balance(w)).toBe(17);
    const spend = await prisma.inTenant(w.tenantId, (tx) => tx.creditSpend.findFirstOrThrow({ where: { kind: 'spend' } }));
    expect(spend).toMatchObject({ customerId: w.luna, amount: 3, reason: 'ai.brand_content', reference: `ai_run:${id}` });
    expect(await prisma.inTenant(w.tenantId, (tx) => tx.aiRun.findUniqueOrThrow({ where: { id } }))).toMatchObject({
      userId: w.anna.id,
      kind: 'brand_content',
      input: { customerId: w.luna, description: 'A silver ring' },
    });

    // Every member reads it; another customer never does.
    await w.vic.client.get(portal(w.luna, `/runs/${id}`)).expect(200);
    await w.sam.client.get(portal(w.sol, `/runs/${id}`)).expect(404);
    await w.anna.client.get(portal(w.luna, `/runs/${newId()}`)).expect(404);
  });

  it('charges the price set by staff; a run keeps the price it was charged at', async () => {
    const w = await workspace();
    await allowBrand(w);
    const first = await ask(w);
    await finished(w, first.id);

    await w.staff.put('/settings/ai.toolPrices', { recommendations: 10, marketing: 5, brand_content: 4, image: 5 }).expect(200);
    const second = await ask(w);

    expect((await finished(w, second.id)).credits).toBe(4);
    expect((await finished(w, first.id)).credits).toBe(3);
    expect(await balance(w)).toBe(13);
  });

  it('gives the credits back once when the run fails, and shows a plain error', async () => {
    const w = await workspace();
    await allowBrand(w);
    behaviour = 'throw';

    const { id } = await ask(w);
    const failed = await finished(w, id);
    expectDocumented(customerResultSchema, failed);
    expect(failed).toMatchObject({ status: 'failed', output: null, error: CUSTOMER_FAILED_MESSAGE, credits: 3 });
    // The internal error stays in the run log.
    expect(
      (await prisma.inTenant(w.tenantId, (tx) => tx.aiRunResult.findUniqueOrThrow({ where: { runId: id } }))).error,
    ).toBe('the model is down');

    const back = await waitFor(async () => {
      const body = (await w.anna.client.get(portal(w.luna, `/runs/${id}`)).expect(200)).body as Result;
      return body.credits_given_back ? body : undefined;
    });
    expect(back.credits_given_back).toBe(true);
    expect(await balance(w)).toBe(20);

    // Failing it again writes no second result, so gives nothing back twice.
    await runs.fail(w.tenantId, id, 'failed again');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await balance(w)).toBe(20);
    expect(await count(w)).toEqual({ runs: 1, results: 1, spends: 1, givenBack: 1 });
  });

  it("gives a failed run's credits back on the sweep when the give-back job could not be queued (review fix)", async () => {
    const w = await workspace();
    await allowBrand(w);
    // The worker fails the run and queues the give-back; here that queueing fails.
    const jobs = worker.get(JobsService);
    const enqueue = jobs.enqueue.bind(jobs);
    const spy = jest.spyOn(jobs, 'enqueue').mockImplementation(((name: string, payload: unknown) =>
      name === 'ai.credits.give_back' ? Promise.reject(new Error('queue down')) : enqueue(name as never, payload as never)) as typeof jobs.enqueue);
    try {
      behaviour = 'throw';
      const { id } = await ask(w);
      expect(await finished(w, id)).toMatchObject({ status: 'failed', credits_given_back: false });
      await waitFor(async () => (spy.mock.calls.some(([name]) => name === 'ai.credits.give_back') ? true : undefined));
      expect(await balance(w)).toBe(17);

      expect(await tools.giveBackDue(w.tenantId)).toBe(1);
      expect(await balance(w)).toBe(20);
      expect((await finished(w, id)).credits_given_back).toBe(true);

      expect(await tools.giveBackDue(w.tenantId)).toBe(0);
      expect(await count(w)).toEqual({ runs: 1, results: 1, spends: 1, givenBack: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it('takes the last credits only once when two runs ask at the same moment (Review Focus 1)', async () => {
    const w = await workspace(4);
    await allowBrand(w);

    const both = await Promise.allSettled([ask(w), ask(w)]);

    expect(both.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    const refused = both.filter((one) => one.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(((refused[0] as PromiseRejectedResult).reason as Error).message).toBe('Not enough credits');
    expect(await count(w)).toEqual({ runs: 1, results: 1, spends: 1, givenBack: 0 });
    expect(await balance(w)).toBe(1);
  });

  it("charges nothing when the workspace's AI limit is used (Review Focus 2)", async () => {
    const w = await workspace();
    await allowBrand(w);
    await finished(w, (await ask(w)).id);
    expect(await balance(w)).toBe(17);

    // 1.00 USD spent this month: a limit of 1.00 is used.
    await setLimit(w.tenantId, '1.00');

    await expect(ask(w)).rejects.toThrow(ConflictException);
    await expect(ask(w)).rejects.toThrow("This month's AI limit is used");
    expect(await balance(w)).toBe(17);
    expect(await count(w)).toEqual({ runs: 1, results: 1, spends: 1, givenBack: 0 });
  });

  it('lists the history newest first, and deletes from it while the run log and the ledger keep their rows', async () => {
    const w = await workspace();
    await allowBrand(w);
    const older = await ask(w);
    await finished(w, older.id);
    const newer = await ask(w);
    await finished(w, newer.id);

    const listed = await w.vic.client.get(portal(w.luna, '/results?tool=brand_content')).expect(200);
    expectDocumented(pageSchema(customerResultSchema), listed.body);
    expect((listed.body as { data: Result[] }).data.map((one) => one.id)).toEqual([newer.id, older.id]);
    expect(((await w.anna.client.get(portal(w.luna, '/results?tool=image')).expect(200)).body as { data: Result[] }).data).toEqual([]);
    await w.anna.client.get(portal(w.luna, '/results?tool=made_up')).expect(400);
    expect(((await w.sam.client.get(portal(w.sol, '/results')).expect(200)).body as { data: Result[] }).data).toEqual([]);

    const page = (await w.anna.client.get(portal(w.luna, '/results?limit=1')).expect(200)).body as { data: Result[]; next_cursor: string };
    expect(page.data.map((one) => one.id)).toEqual([newer.id]);
    const rest = (await w.anna.client.get(portal(w.luna, `/results?limit=1&cursor=${page.next_cursor}`)).expect(200)).body as {
      data: Result[];
      next_cursor: string | null;
    };
    expect(rest).toMatchObject({ data: [{ id: older.id }], next_cursor: null });

    // Admins and above delete; a buyer may not. Another customer's is not found.
    await w.ben.client.delete(portal(w.luna, `/results/${older.id}`)).expect(403);
    await w.sam.client.delete(portal(w.sol, `/results/${older.id}`)).expect(404);
    await w.anna.client.delete(portal(w.luna, `/results/${older.id}`)).expect(204);

    const after = (await w.anna.client.get(portal(w.luna, '/results')).expect(200)).body as { data: Result[] };
    expect(after.data.map((one) => one.id)).toEqual([newer.id]);
    await w.anna.client.get(portal(w.luna, `/runs/${older.id}`)).expect(404);
    await w.anna.client.delete(portal(w.luna, `/results/${older.id}`)).expect(404);

    // No credits back; the run log and the credit ledger keep their rows.
    expect(await balance(w)).toBe(14);
    expect(await count(w)).toEqual({ runs: 2, results: 2, spends: 2, givenBack: 0 });
    expect(
      await prisma.inTenant(w.tenantId, (tx) => tx.aiCustomerResult.findUniqueOrThrow({ where: { runId: older.id } })),
    ).toMatchObject({ deletedAt: expect.any(Date), deletedByUserId: w.anna.id });
    const log = await w.staff.get('/ai/runs').expect(200);
    expectDocumented(aiRunListResponseSchema, log.body);
    expect((log.body as { data: { id: string; kind: string }[] }).data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: older.id, kind: 'brand_content' })]),
    );
  });

  it('refuses to delete a run still running', async () => {
    const w = await workspace();
    await allowBrand(w);
    behaviour = 'hold';

    const { id } = await ask(w);
    expect(((await w.anna.client.get(portal(w.luna, `/runs/${id}`)).expect(200)).body as Result).status).toBe('pending');
    const refused = await w.anna.client.delete(portal(w.luna, `/results/${id}`)).expect(409);
    expect(JSON.stringify(refused.body)).toContain('Still running');

    release();
    await finished(w, id);
    await w.anna.client.delete(portal(w.luna, `/results/${id}`)).expect(204);
  });

  it('keeps the customer results behind row-level security', async () => {
    const [table] = await prisma.$queryRaw<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS "enabled", relforcerowsecurity AS "forced" FROM pg_class WHERE relname = 'ai_customer_result'`;

    expect(table).toEqual({ enabled: true, forced: true });
  });
});
