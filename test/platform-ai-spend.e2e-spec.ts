import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { monthBounds } from '../src/modules/ai/ai-limit';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { hashPassword } from '../src/modules/identity/passwords';
import { aiSpendResponseSchema } from '../src/platform/ai-spend.service';
import type { AiSpendResponse } from '../src/platform/ai-spend.service';
import { tenantResponseSchema } from '../src/platform/tenant.service';
import type { TenantResponse } from '../src/platform/tenant.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

describe('platform AI spend', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let adminId: string;
  let adminToken: string;
  const createdTenants: string[] = [];

  const get = (query: string, token = adminToken) =>
    request(app.getHttpServer()).get(`/platform/ai-spend${query}`).set('Authorization', `Bearer ${token}`);

  // Known moments of the current UTC month, both already past: the 1st just after midnight and today just
  // after midnight (the same day on the 1st).
  const now = new Date();
  const firstMoment = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 30));
  const todayMoment = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 30));
  const dayOf = (at: Date) => at.toISOString().slice(0, 10);

  /** A finished run costing `cost` at `finishedAt`, in the workspace. */
  async function addRun(tenantId: string, cost: string, finishedAt: Date): Promise<void> {
    await prisma.inTenant(tenantId, async (tx) => {
      const run = await tx.aiRun.create({ data: { kind: 'ask', model: 'test-model', input: {} } });
      await tx.aiRunResult.create({
        data: {
          runId: run.id,
          status: 'done',
          inputTokens: 10,
          outputTokens: 10,
          costUsd: new Prisma.Decimal(cost),
          refs: [],
          finishedAt,
        },
      });
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);

    const admin = await prisma.platformAdmin.create({
      data: {
        email: `platform-${newId()}@example.test`,
        passwordHash: await hashPassword('platform-admin-password'),
        name: 'Platform Admin',
      },
    });
    adminId = admin.id;
    adminToken = (await tokens.issueForPlatformAdmin(admin.id)).accessToken;
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await prisma.platformAdmin.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  it("gives each day's spend per workspace and the month's total", async () => {
    const first = await createTestTenant(prisma);
    const second = await createTestTenant(prisma);
    createdTenants.push(first.id, second.id);
    await prisma.inTenant(first.id, (tx) => tx.tenant.update({ where: { id: first.id }, data: { aiMonthlyLimitUsd: new Prisma.Decimal('20') } }));

    await addRun(first.id, '1.25', firstMoment);
    await addRun(first.id, '0.75', firstMoment);
    await addRun(first.id, '3.00', todayMoment);
    await addRun(second.id, '0.50', todayMoment);
    // Last month's run counts for neither.
    await addRun(first.id, '9.00', new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 12)));

    const response = await get('').expect(200);
    expectDocumented(aiSpendResponseSchema, response.body);
    const body = response.body as AiSpendResponse;

    expect(body.month).toBe(monthBounds(now).key);
    // Every UTC day up to today, oldest first, once each.
    expect(body.days.map((day) => day.date)).toEqual(
      Array.from({ length: now.getUTCDate() }, (_, index) => dayOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), index + 1)))),
    );

    const expected = new Map<string, Map<string, Prisma.Decimal>>();
    for (const [tenantId, cost, at] of [
      [first.id, '1.25', firstMoment],
      [first.id, '0.75', firstMoment],
      [first.id, '3.00', todayMoment],
      [second.id, '0.50', todayMoment],
    ] as const) {
      const perTenant = expected.get(tenantId) ?? new Map<string, Prisma.Decimal>();
      perTenant.set(dayOf(at), (perTenant.get(dayOf(at)) ?? new Prisma.Decimal(0)).plus(cost));
      expected.set(tenantId, perTenant);
    }

    for (const tenant of [first, second]) {
      const entry = body.tenants.find((one) => one.id === tenant.id);
      expect(entry).toBeDefined();
      let sum = new Prisma.Decimal(0);
      for (const day of body.days) {
        const spent = day.tenants.find((one) => one.tenant_id === tenant.id);
        const want = expected.get(tenant.id)?.get(day.date);
        expect(spent?.usd).toBe(want?.toFixed(2));
        if (spent) sum = sum.plus(spent.usd);
      }
      expect(entry?.spent_usd).toBe(sum.toFixed(2));

      // The same figure the tenant view shows.
      const view = await request(app.getHttpServer())
        .get(`/platform/tenants/${tenant.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expectDocumented(tenantResponseSchema, view.body);
      expect(entry?.spent_usd).toBe((view.body as TenantResponse).ai.spent_this_month_usd);
    }

    expect(body.tenants.find((one) => one.id === first.id)).toMatchObject({ monthly_limit_usd: '20.00', spent_usd: '5.00' });
    expect(body.tenants.find((one) => one.id === second.id)).toMatchObject({ monthly_limit_usd: null, spent_usd: '0.50' });
    // The biggest spender first.
    const ids = body.tenants.map((one) => one.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
  });

  it('lists a workspace with no runs at 0.00', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);

    const response = await get('').expect(200);
    expectDocumented(aiSpendResponseSchema, response.body);
    const body = response.body as AiSpendResponse;

    expect(body.tenants.find((one) => one.id === tenant.id)).toMatchObject({ monthly_limit_usd: null, spent_usd: '0.00' });
    expect(body.days.some((day) => day.tenants.some((one) => one.tenant_id === tenant.id))).toBe(false);
  });

  it('answers a past month in full, refuses a future month and a bad month with 400', async () => {
    // January of last year: a past month whose 31 days are all answered, with no entry of ours.
    const year = now.getUTCFullYear() - 1;
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await addRun(tenant.id, '2.40', new Date(Date.UTC(year, 0, 31, 23, 59, 59)));

    const response = await get(`?month=${year}-01`).expect(200);
    expectDocumented(aiSpendResponseSchema, response.body);
    const body = response.body as AiSpendResponse;
    expect(body.month).toBe(`${year}-01`);
    expect(body.days).toHaveLength(31);
    expect(body.days[0].date).toBe(`${year}-01-01`);
    expect(body.days[30].date).toBe(`${year}-01-31`);
    expect(body.days[30].tenants.find((one) => one.tenant_id === tenant.id)?.usd).toBe('2.40');
    expect(body.tenants.find((one) => one.id === tenant.id)?.spent_usd).toBe('2.40');

    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
    await get(`?month=${next}`).expect(400);
    await get('?month=2026-13').expect(400);
    await get('?month=last-month').expect(400);
  });

  it('refuses tenant tokens', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const { accessToken } = await tokens.issueForUser(tenant.id, owner.id);

    await get('', accessToken).expect(403);
    await request(app.getHttpServer()).get('/platform/ai-spend').expect(401);
  });
});
