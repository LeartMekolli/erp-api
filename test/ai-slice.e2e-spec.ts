import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedAi } from '../src/cli/seed-ai';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AI_PROVIDER } from '../src/modules/ai/ai-provider';
import { BriefingService } from '../src/modules/ai/briefing.service';
import { fakeToolUse } from '../src/modules/ai/fake-ai-provider';
import type { FakeAiProvider } from '../src/modules/ai/fake-ai-provider';
import { ArticlesService } from '../src/modules/ai/knowledge/articles.service';
import type { FakeVectorStore } from '../src/modules/ai/knowledge/fake-vector-store';
import { VECTOR_STORE, namespaceOf } from '../src/modules/ai/knowledge/vector-store';
import { aiRunListResponseSchema, aiRunResponseSchema } from '../src/modules/ai/run-response';
import { RunsService } from '../src/modules/ai/runs.service';
import { searchResponseSchema } from '../src/modules/ai/search-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { hashPassword } from '../src/modules/identity/passwords';
import { dashboardResponseSchema } from '../src/modules/reporting/dashboard-response';
import { ReportsService } from '../src/modules/reporting/reports.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface Ref {
  type: string;
  id: string;
  label: string;
}
interface Run {
  id: string;
  status: string;
  answer: { text: string; refs: Ref[]; action: { kind: string; targets: Ref[] } | null } | null;
}
interface Dashboard {
  current: { orders: { placed: number; revenue?: string } };
  attention: { kind: string; total: number; items: { ref: { type: string; id: string } }[] }[];
  ai?:
    | { enabled: true; pending: boolean; briefing: { summary: string; suggestions: { id: string; kind: string; targets: Ref[] }[] } | null }
    | { enabled: false; reason: string };
}

const fixture: JobRegistry = {
  jobs: { ...JOBS, 'ai.run': { ...JOBS['ai.run'], backoffMs: 10 }, 'knowledge.index': { ...JOBS['knowledge.index'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};
const SETUP_MS = 90_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The AI 1 spec's "Done when", 1 to 8, in one workspace with the fake model and the fake vector store
 * (AI 1 plan, Task 9). Each step builds on the last, so the steps run in order.
 */
describe('ai: the dashboard and Cmd+K, end to end', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakeAiProvider;
  let store: FakeVectorStore;
  let adminId: string;
  let adminToken: string;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });
  type Client = ReturnType<typeof as>;

  let tenantId: string;
  let ownerId: string;
  let owner: Client;
  let operator: Client;
  let brightline: string;
  let northcast: string;
  let layerline: string;
  let late: { id: string; number: number };
  let offer: string;
  let suggestionId: string;
  let lateRunId: string;

  /**
   * Brightline with an order promised yesterday, Northcast with a cast job offered 25 hours ago, Layerline,
   * and an operator who may use the AI and read reports, orders, customers, partners and workflows, but
   * not payments.
   */
  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JOB_REGISTRY).useValue(fixture).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
    // Runs and indexing happen in the worker, so its fakes answer and hold the passages.
    fake = worker.get<FakeAiProvider>(AI_PROVIDER);
    store = worker.get<FakeVectorStore>(VECTOR_STORE);

    const admin = await prisma.platformAdmin.create({
      data: { email: `platform-${newId()}@example.test`, passwordHash: await hashPassword('platform-admin-password'), name: 'Platform Admin' },
    });
    adminId = admin.id;
    adminToken = (await tokens.issueForPlatformAdmin(admin.id)).accessToken;

    const tenant = await createTestTenant(prisma);
    tenantId = tenant.id;
    createdTenants.push(tenant.id);
    const ownerUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    ownerId = ownerUser.id;
    const operatorUser = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      const role = await tx.role.create({ data: { name: 'operator', isSystem: false } });
      await tx.rolePermission.createMany({
        data: ['ai.use', 'report.read', 'order.read', 'customer.read', 'partner.read', 'workflow.read'].map((permission) => ({
          roleId: role.id,
          permission,
        })),
      });
      await tx.userRole.create({ data: { userId: operatorUser.id, roleId: role.id } });
    });
    owner = as((await tokens.issueForUser(tenant.id, ownerUser.id)).accessToken);
    operator = as((await tokens.issueForUser(tenant.id, operatorUser.id)).accessToken);

    const cast = await pricedCastPart(owner, prisma, { id: tenant.id, staffUserId: ownerUser.id, runMetal });
    await owner.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const speeds = (await owner.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] };
    await owner.patch(`/pricing/delivery-speeds/${speeds.data.find((speed) => speed.key === 'standard')!.id}`, { working_days: 10 }).expect(200);
    await owner.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await owner.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '0' }] }).expect(200);
    brightline = ((await owner.post('/customers', { name: 'Brightline' }).expect(201)).body as { id: string }).id;
    await owner.put(`/customers/${brightline}/payment-terms`, { terms: 'pay_later' }).expect(200);
    const quote = ((
      await owner
        .post('/pricing/quotes', {
          product_id: cast.productId,
          options: { material: 'silver_925', finish: 'polished' },
          size: { scale: '1.5' },
          quantity: 2,
          file_version_id: cast.versionId,
          customer_id: brightline,
        })
        .expect(201)
    ).body as { quote: { id: string } }).quote;
    const placed = (
      await owner
        .post('/orders', {
          customer_id: brightline,
          lines: [{ quote_id: quote.id }],
          address: { name: 'Brightline', line1: 'Main street 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
          shipping_method: 'courier',
        })
        .expect(201)
    ).body as { id: string; number: number; lines: { group_id: string }[] };
    late = { id: placed.id, number: placed.number };
    const yesterday = new Date(new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime() - DAY_MS);
    await prisma.inTenant(tenant.id, (tx) => tx.order.update({ where: { id: late.id }, data: { promisedOn: yesterday } }));

    northcast = ((await owner.post('/partners', { name: 'Northcast Foundry', display_name: 'Northcast' }).expect(201)).body as { id: string }).id;
    layerline = ((await owner.post('/partners', { name: 'Layerline', display_name: 'Layerline' }).expect(201)).body as { id: string }).id;
    // An offer nobody has answered for a day: written directly, since waiting a real day isn't possible here.
    offer = (
      await prisma.inTenant(tenant.id, (tx) =>
        tx.jobAssignment.create({
          data: {
            groupId: placed.lines[0].group_id,
            partnerId: northcast,
            kind: 'offer',
            status: 'offered',
            cost: new Prisma.Decimal('50.00'),
            expiresAt: new Date(Date.now() + DAY_MS),
            createdByUserId: ownerUser.id,
            createdAt: new Date(Date.now() - 25 * HOUR_MS),
          },
        }),
      )
    ).id;
  }, SETUP_MS);

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await prisma.platformAdmin.delete({ where: { id: adminId } });
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  const setLimit = (monthlyUsd: string | null) =>
    http().put(`/platform/tenants/${tenantId}/ai-limit`).set('Authorization', `Bearer ${adminToken}`).send({ monthly_usd: monthlyUsd });
  const dashboard = async (client: Client) => {
    const response = await client.get('/reports/dashboard').expect(200);
    expectDocumented(dashboardResponseSchema, response.body);
    return response.body as Dashboard;
  };
  const suggestionsOf = (board: Dashboard) => (board.ai?.enabled ? (board.ai.briefing?.suggestions ?? []) : null);
  const briefingAfter = (runId: string) =>
    waitFor(async () => {
      const row = await prisma.inTenant(tenantId, (tx) => tx.aiBriefing.findUnique({ where: { runId }, include: { suggestions: true } }));
      return row ?? undefined;
    });
  const scriptBriefing = () =>
    fake.script(
      fakeToolUse('attention', {}),
      fakeToolUse('get_partner', { id: northcast }),
      fakeToolUse('brief', {
        summary: 'One order is late and one offer has waited a day.',
        suggestions: [
          {
            kind: 'offer_job',
            targets: [
              { type: 'job', id: offer },
              { type: 'partner', id: northcast },
            ],
            reason: 'Unanswered for 25 hours.',
          },
        ],
      }),
    );
  const ask = async (client: Client, question: string) => {
    const id = ((await client.post('/ai/ask', { question }).expect(202)).body as { id: string }).id;
    const run = await waitFor(async () => {
      const one = (await client.get(`/ai/runs/${id}`).expect(200)).body as Run;
      return one.status === 'pending' ? undefined : one;
    });
    return run;
  };

  it('1. a platform admin sets a $20 limit, and the seed adds three articles without changing it', async () => {
    const set = await setLimit('20.00').expect(200);
    expect((set.body as { ai: unknown }).ai).toEqual({ monthly_limit_usd: '20.00', spent_this_month_usd: '0.00' });

    expect(await seedAi({ prisma, articles: app.get(ArticlesService) }, tenantId, ownerId)).toEqual({ limit: 0, articles: 3 });
    const articles = await prisma.inTenant(tenantId, (tx) => tx.knowledgeArticle.findMany({ select: { id: true } }));
    for (const article of articles) {
      await waitFor(async () => (store.passagesOf(namespaceOf(tenantId), article.id).length > 0 ? true : undefined));
    }
  });

  it('2. the owner sees the week, what needs attention and the briefing, its suggestion labelled', async () => {
    await app.get(ReportsService).refresh(tenantId, new Date());
    scriptBriefing();
    const runId = ((await owner.post('/reports/dashboard/briefing').expect(202)).body as { id: string }).id;
    await briefingAfter(runId);

    const board = await dashboard(owner);
    expect(board.current.orders.placed).toBe(1);
    expect(board.current.orders.revenue).toBeDefined();
    const atRisk = board.attention.find((group) => group.kind === 'order_at_risk')!;
    expect(atRisk.items.map((item) => item.ref.id)).toContain(late.id);
    const unanswered = board.attention.find((group) => group.kind === 'offer_unanswered')!;
    expect(unanswered.items.map((item) => item.ref.id)).toContain(offer);

    expect(board.ai).toMatchObject({ enabled: true, briefing: { summary: 'One order is late and one offer has waited a day.' } });
    const suggestions = suggestionsOf(board)!;
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      kind: 'offer_job',
      targets: [
        { type: 'job', id: offer, label: expect.stringContaining('Northcast') },
        { type: 'partner', id: northcast, label: 'Northcast Foundry' },
      ],
    });
    suggestionId = suggestions[0].id;
  });

  it('3. staff without payment.read see no revenue and no briefing', async () => {
    const board = await dashboard(operator);
    expect(board.current.orders.revenue).toBeUndefined();
    expect(board.attention.map((group) => group.kind)).not.toContain('invoice_overdue');
    expect(board.ai).toBeUndefined();
  });

  it('4. a dismissed suggestion does not come back with the next briefing', async () => {
    await owner.post(`/reports/dashboard/suggestions/${suggestionId}/dismiss`).expect(204);
    expect(suggestionsOf(await dashboard(owner))).toEqual([]);

    scriptBriefing();
    // A refresh within 15 minutes is refused, so the next briefing is queued as the morning job does.
    await owner.post('/reports/dashboard/briefing').expect(409);
    const again = await briefingAfter((await app.get(BriefingService).queue(tenantId)).runId);
    expect(again.suggestions).toEqual([]);
    expect(suggestionsOf(await dashboard(owner))).toEqual([]);
  });

  it('5. Cmd+K finds the order and the partner, and answers with orders, an article and an action', async () => {
    const byNumber = await owner.get(`/search?q=${late.number}`).expect(200);
    expectDocumented(searchResponseSchema, byNumber.body);
    expect((byNumber.body as { orders: { id: string }[] }).orders.map((one) => one.id)).toContain(late.id);
    const byName = (await owner.get('/search?q=Northcast').expect(200)).body as { partners: { id: string }[] };
    expect(byName.partners.map((one) => one.id)).toEqual([northcast]);

    fake.script(
      fakeToolUse('find_orders', { customer_id: brightline, late: true }),
      fakeToolUse('answer', { text: `Order ${late.number} is late.`, refs: [{ type: 'order', id: late.id }], action: null }),
    );
    const lateRun = await ask(owner, "Which of Brightline's orders are late?");
    lateRunId = lateRun.id;
    expectDocumented(aiRunResponseSchema, (await owner.get(`/ai/runs/${lateRun.id}`).expect(200)).body);
    expect(lateRun.answer?.refs).toEqual([{ type: 'order', id: late.id, label: expect.stringContaining(String(late.number)) }]);

    const article = await prisma.inTenant(tenantId, (tx) => tx.knowledgeArticle.findFirstOrThrow({ where: { title: 'Handling a failed casting QC' } }));
    fake.script(
      fakeToolUse('search_knowledge', { query: 'failed casting QC' }),
      fakeToolUse('answer', { text: 'Follow the casting QC article.', refs: [{ type: 'article', id: article.id }], action: null }),
    );
    const qc = await ask(owner, 'How do we handle a failed casting QC?');
    expect(qc.answer?.refs).toEqual([{ type: 'article', id: article.id, label: 'Handling a failed casting QC' }]);

    fake.script(
      fakeToolUse('attention', {}),
      fakeToolUse('find_partners', { name: 'Layerline' }),
      fakeToolUse('answer', {
        text: 'Offer the waiting cast job to Layerline.',
        refs: [],
        action: {
          kind: 'offer_job',
          targets: [
            { type: 'job', id: offer },
            { type: 'partner', id: layerline },
          ],
        },
      }),
    );
    const action = await ask(owner, 'Offer the waiting cast job to Layerline');
    expect(action.answer?.action).toEqual({
      kind: 'offer_job',
      targets: [
        { type: 'job', id: offer, label: expect.any(String) },
        { type: 'partner', id: layerline, label: 'Layerline' },
      ],
    });
  });

  it('6. asking about revenue without payment.read gets no amount', async () => {
    const before = fake.calls.length;
    fake.script(
      fakeToolUse('dashboard_numbers', {}, 'call_numbers'),
      fakeToolUse('answer', { text: 'I can’t see revenue.', refs: [], action: null }),
    );

    const run = await ask(operator, 'What was our revenue this week?');

    expect(run.status).toBe('done');
    const toolResult = JSON.stringify(fake.calls[before + 1].messages.at(-1));
    expect(toolResult).toContain('call_numbers');
    expect(toolResult).not.toContain('revenue');
  });

  it('7. a limit lowered below the month’s spend refuses the next ask and refresh, and staff are told once', async () => {
    // One run is still being answered while the limit is lowered; it finishes past the new limit.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    worker.get(RunsService).onKind('ask', async () => {
      await gate;
      return { status: 'done', usage: { inputTokens: 1_000, outputTokens: 0 }, output: { text: 'Done.', refs: [], action: null }, refs: [], error: null };
    });
    const held = ((await owner.post('/ai/ask', { question: 'Anything else?' }).expect(202)).body as { id: string }).id;

    await setLimit('0.00').expect(200);
    release();
    await waitFor(async () => (await prisma.inTenant(tenantId, (tx) => tx.aiRunResult.findUnique({ where: { runId: held } }))) ?? undefined);

    expect(JSON.stringify((await owner.post('/ai/ask', { question: 'And now?' }).expect(409)).body)).toContain("This month's AI limit is used");
    await owner.post('/reports/dashboard/briefing').expect(409);
    expect((await dashboard(owner)).ai).toEqual({ enabled: false, reason: 'limit_used' });
    const told = await waitFor(async () => {
      const rows = await prisma.inTenant(tenantId, (tx) => tx.notification.findMany({ where: { eventKey: 'ai.limit_used' } }));
      return rows.length > 0 ? rows : undefined;
    });
    expect(told).toHaveLength(1);
  });

  it('8. the run log shows every run with its tokens, cost and the records it read, and is never changed', async () => {
    const log = await owner.get('/ai/runs?limit=100').expect(200);
    expectDocumented(aiRunListResponseSchema, log.body);
    const runs = (log.body as { data: { id: string; kind: string; status: string; input_tokens: number | null; cost_usd: string | null }[] }).data;
    expect(runs.filter((run) => run.kind === 'briefing')).toHaveLength(2);
    expect(runs.filter((run) => run.kind === 'ask')).toHaveLength(5);
    for (const run of runs) {
      expect(run.status).toBe('done');
      expect(run.input_tokens).toBeGreaterThan(0);
      expect(Number(run.cost_usd)).toBeGreaterThan(0);
    }

    const result = await prisma.inTenant(tenantId, (tx) => tx.aiRunResult.findUniqueOrThrow({ where: { runId: lateRunId } }));
    expect(result.refs).toContainEqual({ type: 'order', id: late.id });

    await expect(prisma.inTenant(tenantId, (tx) => tx.$executeRaw`UPDATE ai_run SET model = 'other'`)).rejects.toThrow();
    await expect(prisma.inTenant(tenantId, (tx) => tx.$executeRaw`DELETE FROM ai_run_result`)).rejects.toThrow();
  });
});
