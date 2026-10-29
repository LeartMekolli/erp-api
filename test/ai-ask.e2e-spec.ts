import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AI_PROVIDER } from '../src/modules/ai/ai-provider';
import { fakeToolUse } from '../src/modules/ai/fake-ai-provider';
import type { FakeAiProvider } from '../src/modules/ai/fake-ai-provider';
import { aiRunListResponseSchema, aiRunResponseSchema } from '../src/modules/ai/run-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface Run {
  id: string;
  status: string;
  answer: { text: string; refs: { type: string; id: string; label: string }[]; action: unknown } | null;
}

const fixture: JobRegistry = { jobs: { ...JOBS, 'ai.run': { ...JOBS['ai.run'], backoffMs: 10 } }, scheduled: SCHEDULED_JOBS };
const SETUP_MS = 60_000;
const DAY_MS = 86_400_000;

/** Staff ask about their workspace, answered from what they may see (AI 1 plan, Task 5). */
describe('ai: ask', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakeAiProvider;
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
  let owner: Client;
  let asker: Client;
  let member: Client;
  let brightline: string;
  let late: { id: string; number: number };

  /**
   * A workspace with a $5 AI limit, Brightline with one order promised yesterday, and an asker who may
   * use the AI and read orders and reports, but not payments or partners.
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
    // The run executes in the worker, so the worker's fake answers.
    fake = worker.get<FakeAiProvider>(AI_PROVIDER);

    const tenant = await createTestTenant(prisma);
    tenantId = tenant.id;
    createdTenants.push(tenant.id);
    const ownerUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const askerUser = await createTestUser(prisma, tenant.id, { roles: [] });
    const memberUser = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.tenant.update({ where: { id: tenant.id }, data: { aiMonthlyLimitUsd: new Prisma.Decimal('5.00') } });
      const role = await tx.role.create({ data: { name: 'asker', isSystem: false } });
      await tx.rolePermission.createMany({
        data: ['ai.use', 'order.read', 'report.read', 'customer.read'].map((permission) => ({ roleId: role.id, permission })),
      });
      await tx.userRole.create({ data: { userId: askerUser.id, roleId: role.id } });
    });
    owner = as((await tokens.issueForUser(tenant.id, ownerUser.id)).accessToken);
    asker = as((await tokens.issueForUser(tenant.id, askerUser.id)).accessToken);
    member = as((await tokens.issueForUser(tenant.id, memberUser.id)).accessToken);

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
    late = (
      await owner
        .post('/orders', {
          customer_id: brightline,
          lines: [{ quote_id: quote.id }],
          address: { name: 'Brightline', line1: 'Main street 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
          shipping_method: 'courier',
        })
        .expect(201)
    ).body as { id: string; number: number };
    const yesterday = new Date(new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime() - DAY_MS);
    await prisma.inTenant(tenant.id, (tx) => tx.order.update({ where: { id: late.id }, data: { promisedOn: yesterday } }));
  }, SETUP_MS);

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  const ask = async (client: Client, question: string) =>
    ((await client.post('/ai/ask', { question }).expect(202)).body as { id: string }).id;
  const finished = (client: Client, id: string) =>
    waitFor(async () => {
      const run = (await client.get(`/ai/runs/${id}`).expect(200)).body as Run;
      return run.status === 'pending' ? undefined : run;
    });

  it("answers which of Brightline's orders are late, citing the order with its label", async () => {
    fake.script(
      fakeToolUse('find_orders', { customer_id: brightline, late: true }),
      fakeToolUse('answer', { text: `Order ${late.number} is late.`, refs: [{ type: 'order', id: late.id }], action: null }),
    );

    const id = await ask(owner, "Which of Brightline's orders are late?");
    const run = await finished(owner, id);

    const response = await owner.get(`/ai/runs/${id}`).expect(200);
    expectDocumented(aiRunResponseSchema, response.body);
    expect(run.status).toBe('done');
    expect(run.answer).toEqual({
      text: `Order ${late.number} is late.`,
      refs: [{ type: 'order', id: late.id, label: expect.stringContaining(String(late.number)) }],
      action: null,
    });

    // Only the asker reads a run.
    await asker.get(`/ai/runs/${id}`).expect(404);

    const log = await owner.get('/ai/runs').expect(200);
    expectDocumented(aiRunListResponseSchema, log.body);
    const logged = (log.body as { data: { id: string; status: string; cost_usd: string; input_tokens: number }[] }).data.find((one) => one.id === id);
    expect(logged).toMatchObject({ status: 'done', input_tokens: 200 });
    expect(Number(logged!.cost_usd)).toBeGreaterThan(0);
  });

  it('offers no money tool and shows no revenue to an asker without payment.read (Review Focus 2)', async () => {
    const before = fake.calls.length;
    fake.script(
      fakeToolUse('dashboard_numbers', {}, 'call_numbers'),
      fakeToolUse('answer', { text: 'I can’t see revenue.', refs: [], action: null }),
    );

    const run = await finished(asker, await ask(asker, 'What was our revenue this week?'));

    expect(run.status).toBe('done');
    const [first, second] = fake.calls.slice(before);
    const offered = first.tools.map((tool) => tool.name);
    expect(offered).toContain('dashboard_numbers');
    expect(offered).toContain('find_orders');
    expect(offered).not.toContain('list_invoices');
    expect(offered).not.toContain('find_partners');
    const result = JSON.stringify(second.messages.at(-1));
    expect(result).toContain('call_numbers');
    expect(result).not.toContain('revenue');
  });

  it('refuses at once when the workspace has no AI, and staff without ai.use', async () => {
    const bare = await createTestTenant(prisma);
    createdTenants.push(bare.id);
    const bareOwner = await createTestUser(prisma, bare.id, { roles: ['owner'] });
    const client = as((await tokens.issueForUser(bare.id, bareOwner.id)).accessToken);

    const refused = await client.post('/ai/ask', { question: 'Anything late?' }).expect(409);
    expect(JSON.stringify(refused.body)).toContain('AI is not set up for this workspace');
    expect(await prisma.inTenant(bare.id, (tx) => tx.aiRun.count())).toBe(0);

    await member.post('/ai/ask', { question: 'Anything late?' }).expect(403);
    await owner.post('/ai/ask', { question: '' }).expect(400);
    await owner.post('/ai/ask', { question: 'x'.repeat(501) }).expect(400);
  });

  it('answers 404 for a run of another workspace', async () => {
    const other = await createTestTenant(prisma);
    createdTenants.push(other.id);
    const otherOwner = await createTestUser(prisma, other.id, { roles: ['owner'] });
    const client = as((await tokens.issueForUser(other.id, otherOwner.id)).accessToken);
    const mine = await prisma.inTenant(tenantId, (tx) => tx.aiRun.findFirstOrThrow());

    await client.get(`/ai/runs/${mine.id}`).expect(404);
  });
});
