import { randomBytes } from 'node:crypto';
import { ConflictException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { RunsService } from '../src/modules/ai/runs.service';
import type { RunOutcome } from '../src/modules/ai/runs.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { hashPassword } from '../src/modules/identity/passwords';
import { tenantResponseSchema } from '../src/platform/tenant.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

/** The real jobs, with a tiny backoff so a failing run reaches its last attempt within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'ai.run': { ...JOBS['ai.run'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

/** One million input tokens on Haiku 4.5: exactly 1.00 USD. */
const oneDollar: RunOutcome = {
  status: 'done',
  usage: { inputTokens: 1_000_000, outputTokens: 0 },
  output: { text: 'Done.' },
  refs: [],
  error: null,
};

/** Runs logged and paid within a monthly limit per workspace (AI 1 plan, Task 2). */
describe('ai: runs and the monthly limit', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let runs: RunsService;
  let adminId: string;
  let adminToken: string;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JOB_REGISTRY)
      .useValue(fixture)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    runs = app.get(RunsService);

    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
    const workerRuns = worker.get(RunsService);
    workerRuns.onKind('ask', () => Promise.resolve(oneDollar));
    workerRuns.onKind('briefing', () => Promise.reject(new Error('the model is down')));

    const admin = await prisma.platformAdmin.create({
      data: { email: `platform-${newId()}@example.test`, passwordHash: await hashPassword('platform-admin-password'), name: 'Platform Admin' },
    });
    adminId = admin.id;
    adminToken = (await tokens.issueForPlatformAdmin(admin.id)).accessToken;
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await prisma.platformAdmin.delete({ where: { id: adminId } });
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    return {
      id: tenant.id,
      ownerId: owner.id,
      memberToken: (await tokens.issueForUser(tenant.id, member.id)).accessToken,
    };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const setLimit = (tenantId: string, monthlyUsd: string | null, token = adminToken) =>
    request(app.getHttpServer())
      .put(`/platform/tenants/${tenantId}/ai-limit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ monthly_usd: monthlyUsd });

  const ask = (w: Workspace) => runs.queue(w.id, { userId: w.ownerId, kind: 'ask', payload: { question: 'How are we doing?' } });

  const resultOf = (w: Workspace, runId: string) =>
    waitFor(async () => (await prisma.inTenant(w.id, (tx) => tx.aiRunResult.findUnique({ where: { runId } }))) ?? undefined);

  const spent = (w: Workspace) => prisma.inTenant(w.id, (tx) => runs.spent(tx, new Date()));

  const told = (w: Workspace, eventKey: string) =>
    prisma.inTenant(w.id, (tx) => tx.notification.findMany({ where: { eventKey } }));

  it('refuses a run in a workspace with no limit, and writes nothing', async () => {
    const w = await workspace();

    await expect(ask(w)).rejects.toThrow(ConflictException);
    await expect(ask(w)).rejects.toThrow('AI is not set up for this workspace');
    expect(await prisma.inTenant(w.id, (tx) => tx.aiRun.count())).toBe(0);
  });

  it('lets only a platform admin set the limit, shown on the tenant view', async () => {
    const w = await workspace();

    await setLimit(w.id, '2.00', w.memberToken).expect(403);
    await setLimit(w.id, '-1.00').expect(400);
    await setLimit(w.id, '1.234').expect(400);
    await setLimit(newId(), '2.00').expect(404);

    const set = await setLimit(w.id, '2.00').expect(200);
    expectDocumented(tenantResponseSchema, set.body);
    expect((set.body as { ai: unknown }).ai).toEqual({ monthly_limit_usd: '2.00', spent_this_month_usd: '0.00' });

    const listed = await request(app.getHttpServer())
      .get('/platform/tenants?limit=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const row = (listed.body as { data: { id: string; ai: unknown }[] }).data.find((one) => one.id === w.id);
    expect(row?.ai).toEqual({ monthly_limit_usd: '2.00', spent_this_month_usd: '0.00' });

    const removed = await setLimit(w.id, null).expect(200);
    expect((removed.body as { ai: unknown }).ai).toEqual({ monthly_limit_usd: null, spent_this_month_usd: '0.00' });
    await expect(ask(w)).rejects.toThrow('AI is not set up for this workspace');
  });

  it('logs each run with its cost, tells staff once at 80 % and once at 100 %, then refuses', async () => {
    const w = await workspace();
    await setLimit(w.id, '2.00').expect(200);

    const first = await ask(w);
    const result = await resultOf(w, first.runId);
    expect(result).toMatchObject({ status: 'done', inputTokens: 1_000_000, outputTokens: 0, error: null });
    expect(result.costUsd.toFixed(2)).toBe('1.00');
    expect(await prisma.inTenant(w.id, (tx) => tx.aiRun.findUniqueOrThrow({ where: { id: first.runId } }))).toMatchObject({
      userId: w.ownerId,
      kind: 'ask',
      model: 'claude-haiku-4-5',
    });
    expect((await spent(w)).toFixed(2)).toBe('1.00');
    expect(await told(w, 'ai.limit_nearly_used')).toHaveLength(0);

    const second = await ask(w);
    await resultOf(w, second.runId);
    expect((await spent(w)).toFixed(2)).toBe('2.00');
    const used = await waitFor(async () => {
      const rows = await told(w, 'ai.limit_used');
      return rows.length > 0 ? rows : undefined;
    });
    expect(used).toHaveLength(1);
    expect(used[0].payload).toMatchObject({ limit: '2.00', spent: '2.00' });
    // Crossed on the way to 100 %, so told once at 80 % too.
    expect(await told(w, 'ai.limit_nearly_used')).toHaveLength(1);

    await expect(ask(w)).rejects.toThrow("This month's AI limit is used");

    const view = await setLimit(w.id, '2.00').expect(200);
    expect((view.body as { ai: unknown }).ai).toEqual({ monthly_limit_usd: '2.00', spent_this_month_usd: '2.00' });
  });

  it('accepts at most one more run past the limit when two ask at once (Review Focus 1)', async () => {
    const w = await workspace();
    await setLimit(w.id, '1.10').expect(200);
    await resultOf(w, (await ask(w)).runId);

    const both = await Promise.allSettled([ask(w), ask(w)]);

    expect(both.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    const refused = both.filter((one) => one.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
  });

  it('writes a failed result once a run fails on its last attempt, at no cost', async () => {
    const w = await workspace();
    await setLimit(w.id, '2.00').expect(200);

    const { runId } = await runs.queue(w.id, { userId: null, kind: 'briefing', payload: {} });

    const result = await resultOf(w, runId);
    expect(result).toMatchObject({ status: 'failed', inputTokens: 0, outputTokens: 0, error: 'the model is down' });
    expect(result.costUsd.isZero()).toBe(true);
    expect((await spent(w)).isZero()).toBe(true);
  });
});
