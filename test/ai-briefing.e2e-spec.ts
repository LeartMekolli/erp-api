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
import { AI_PROVIDER } from '../src/modules/ai/ai-provider';
import { BriefingService } from '../src/modules/ai/briefing.service';
import { fakeToolUse } from '../src/modules/ai/fake-ai-provider';
import type { FakeAiProvider } from '../src/modules/ai/fake-ai-provider';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { dashboardResponseSchema } from '../src/modules/reporting/dashboard-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface Suggestion {
  id: string;
  kind: string;
  targets: { type: string; id: string; label: string }[];
  reason: string;
}
type Ai =
  | { enabled: true; pending: boolean; briefing: { summary: string; created_at: string; suggestions: Suggestion[] } | null }
  | { enabled: false; reason: string };

const fixture: JobRegistry = { jobs: { ...JOBS, 'ai.run': { ...JOBS['ai.run'], backoffMs: 10 } }, scheduled: SCHEDULED_JOBS };
const SETUP_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A morning briefing for managers, with suggestions a person acts on (AI 1 plan, Task 8). */
describe('ai: the briefing', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let briefings: BriefingService;
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
  let reader: Client;
  let northcast: string;
  let offer: string;

  /** A $5 limit, a UTC workspace, Northcast with a job offered 25 hours ago, and a staff user with only report.read. */
  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JOB_REGISTRY).useValue(fixture).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    briefings = app.get(BriefingService);
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
    // Briefings run in the worker, so its fake answers.
    fake = worker.get<FakeAiProvider>(AI_PROVIDER);

    const tenant = await createTestTenant(prisma);
    tenantId = tenant.id;
    createdTenants.push(tenant.id);
    const ownerUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const readerUser = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.tenant.update({ where: { id: tenant.id }, data: { aiMonthlyLimitUsd: new Prisma.Decimal('5.00') } });
      const role = await tx.role.create({ data: { name: 'reader', isSystem: false } });
      await tx.rolePermission.create({ data: { roleId: role.id, permission: 'report.read' } });
      await tx.userRole.create({ data: { userId: readerUser.id, roleId: role.id } });
    });
    owner = as((await tokens.issueForUser(tenant.id, ownerUser.id)).accessToken);
    reader = as((await tokens.issueForUser(tenant.id, readerUser.id)).accessToken);

    const cast = await pricedCastPart(owner, prisma, { id: tenant.id, staffUserId: ownerUser.id, runMetal });
    await owner.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const speeds = (await owner.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] };
    await owner.patch(`/pricing/delivery-speeds/${speeds.data.find((speed) => speed.key === 'standard')!.id}`, { working_days: 10 }).expect(200);
    await owner.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await owner.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '0' }] }).expect(200);
    const luna = ((await owner.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    await owner.put(`/customers/${luna}/payment-terms`, { terms: 'pay_later' }).expect(200);
    const quote = ((
      await owner
        .post('/pricing/quotes', {
          product_id: cast.productId,
          options: { material: 'silver_925', finish: 'polished' },
          size: { scale: '1.5' },
          quantity: 2,
          file_version_id: cast.versionId,
          customer_id: luna,
        })
        .expect(201)
    ).body as { quote: { id: string } }).quote;
    const placed = (
      await owner
        .post('/orders', {
          customer_id: luna,
          lines: [{ quote_id: quote.id }],
          address: { name: 'Luna Jewels', line1: 'Main street 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
          shipping_method: 'courier',
        })
        .expect(201)
    ).body as { lines: { group_id: string }[] };
    northcast = ((await owner.post('/partners', { name: 'Northcast Foundry', display_name: 'Northcast' }).expect(201)).body as { id: string }).id;
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
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  const today = () => new Date().toISOString().slice(0, 10);
  const offerJob = () => ({
    kind: 'offer_job',
    targets: [
      { type: 'job', id: offer },
      { type: 'partner', id: northcast },
    ],
    reason: 'Unanswered for a day; Northcast has room.',
  });
  /** The model reads the attention list and the partner, then briefs. */
  const scriptBriefing = (suggestions: object[]) =>
    fake.script(
      fakeToolUse('attention', {}),
      fakeToolUse('get_partner', { id: northcast }),
      fakeToolUse('brief', { summary: 'One offer is waiting for an answer.', suggestions }),
    );
  const aiOf = async (client: Client) => {
    const response = await client.get('/reports/dashboard').expect(200);
    expectDocumented(dashboardResponseSchema, response.body);
    return (response.body as { ai?: Ai }).ai;
  };
  const briefingAfter = (runId: string) =>
    waitFor(async () => {
      const row = await prisma.inTenant(tenantId, (tx) => tx.aiBriefing.findUnique({ where: { runId }, include: { suggestions: true } }));
      return row ?? undefined;
    });

  it('is due from 07:00 in the workspace, once a day', async () => {
    expect(await briefings.due(tenantId, new Date(`${today()}T06:59:00Z`))).toBe(false);
    expect(await briefings.due(tenantId, new Date(`${today()}T07:00:00Z`))).toBe(true);
  });

  it('shows managers the summary and the suggestions it could check, labelled', async () => {
    scriptBriefing([offerJob(), { kind: 'chase_invoice', targets: [{ type: 'invoice', id: newId() }], reason: 'Overdue.' }]);

    const queued = await owner.post('/reports/dashboard/briefing').expect(202);
    const runId = (queued.body as { id: string }).id;
    // A second refresh at once is refused.
    expect(JSON.stringify((await owner.post('/reports/dashboard/briefing').expect(409)).body)).toContain('Refreshed less than 15 minutes ago');
    await briefingAfter(runId);
    // A briefing run today: not due again.
    expect(await briefings.due(tenantId, new Date(`${today()}T23:00:00Z`))).toBe(false);

    const ai = await aiOf(owner);
    expect(ai).toMatchObject({ enabled: true, pending: false, briefing: { summary: 'One offer is waiting for an answer.' } });
    const suggestions = ai?.enabled ? ai.briefing!.suggestions : [];
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      kind: 'offer_job',
      reason: 'Unanswered for a day; Northcast has room.',
      targets: [
        { type: 'job', id: offer, label: expect.stringContaining('Northcast') },
        { type: 'partner', id: northcast, label: 'Northcast Foundry' },
      ],
    });
  });

  it('shows no AI to staff without the manager permissions', async () => {
    expect(await aiOf(reader)).toBeUndefined();
    await reader.post('/reports/dashboard/briefing').expect(403);
  });

  it('keeps a dismissed suggestion away for 14 days, then suggests it again (Review Focus 5)', async () => {
    const shown = await aiOf(owner);
    const suggestion = shown?.enabled ? shown.briefing!.suggestions[0] : undefined;
    await owner.post(`/reports/dashboard/suggestions/${suggestion!.id}/dismiss`).expect(204);
    const after = await aiOf(owner);
    expect(after?.enabled ? after.briefing!.suggestions : null).toEqual([]);

    scriptBriefing([offerJob()]);
    const again = await briefingAfter((await briefings.queue(tenantId)).runId);
    expect(again.suggestions).toEqual([]);

    await prisma.inTenant(tenantId, (tx) => tx.aiSuggestionDismissal.updateMany({ data: { dismissedAt: new Date(Date.now() - 15 * DAY_MS) } }));
    scriptBriefing([offerJob()]);
    const later = await briefingAfter((await briefings.queue(tenantId)).runId);
    expect(later.suggestions.map((one) => one.kind)).toEqual(['offer_job']);
  });

  it('tells managers AI is off when the limit is used or not set, and is never due then', async () => {
    await prisma.inTenant(tenantId, (tx) => tx.tenant.update({ where: { id: tenantId }, data: { aiMonthlyLimitUsd: new Prisma.Decimal('0.00') } }));

    expect(await aiOf(owner)).toEqual({ enabled: false, reason: 'limit_used' });
    expect(await briefings.due(tenantId, new Date(Date.now() + DAY_MS))).toBe(false);
    await owner.post('/reports/dashboard/briefing').expect(409);

    await prisma.inTenant(tenantId, (tx) => tx.tenant.update({ where: { id: tenantId }, data: { aiMonthlyLimitUsd: null } }));
    expect(await aiOf(owner)).toEqual({ enabled: false, reason: 'not_set_up' });
  });
});
