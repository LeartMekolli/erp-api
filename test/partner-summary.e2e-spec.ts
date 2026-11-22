import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { finishedBetween, owedBetween } from '../src/modules/partners/owed-dates';
import { partnerSummaryResponseSchema } from '../src/modules/partners/partner-summary-response';
import { addDays } from '../src/modules/reporting/week-metrics';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface VersionStep {
  key: string;
  name: string;
  step_type: { id: string };
  checklist: object[];
  defects: { defect_id: string; outcome: string; rework_to: string | null }[];
  rework_targets: string[];
  pass: object;
  fail: object;
  customer: object;
}
interface Summary {
  range: { from: string; to: string; previous_from: string; previous_to: string; bucket: string };
  jobs_finished: number;
  previous_jobs_finished: number;
  steps: { key: string; name: string; on_track: number; late: number }[];
  earned?: string;
  previous_earned?: string;
  currency?: string;
  series?: { start: string; days: number; paid: string; owed: string }[];
}

const DAY_MS = 86_400_000;
const d = (value: string) => new Prisma.Decimal(value);
/** Today in the workspace (UTC, as test workspaces are), `days` on. */
const fromToday = (days: number) => new Date(Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The partner's own dashboard numbers (dashboard data spec, "Partner summary"): jobs finished, pieces at its
 * steps now, and for an admin or owner what it earned, paid and still owed per bucket.
 */
describe('partners: their summary', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none, so silver is at its fallback.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });
  type Person = ReturnType<typeof as>;

  async function partnerPerson(tenantId: string, partnerId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind: 'partner' } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'partner', organisationId: partnerId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /**
   * The priced cast part with packing done in-house, so final QC is the payout step; CastCo and MetalWorks
   * approved for the partner steps. Jobs for Luna are made on demand and accepted by CastCo.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const { printPattern, castingTree, casting, polishing } = cast.steps;

    const workflowPath = `/workflow/workflows/${cast.workflow.workflowId}`;
    const current = ((await staff.get(workflowPath).expect(200)).body as { current_version: { steps: VersionStep[] } }).current_version;
    await staff
      .put(`${workflowPath}/steps`, {
        steps: current.steps.map((step) => ({
          key: step.key,
          name: step.name,
          step_type_id: step.step_type.id,
          checklist: step.checklist,
          defects: step.defects.map(({ defect_id, outcome, rework_to }) => ({ defect_id, outcome, ...(rework_to ? { rework_to } : {}) })),
          rework_targets: step.rework_targets,
          pass: step.pass,
          fail: step.fail,
          customer: step.customer,
          done_by: step.key === 'packing' ? 'workspace' : 'partner',
        })),
      })
      .expect(200);

    const partner = async (name: string) => {
      const id = ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
      await staff
        .put(`/partners/${id}/capabilities`, {
          capabilities: [printPattern, castingTree, casting, polishing, cast.workflow.notPriced.finalQc].map((step_type_id) => ({
            step_type_id,
            capacity: 200,
            capacity_period: 'week',
          })),
        })
        .expect(200);
      await staff.put(`/partners/${id}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
      await staff.post(`/partners/${id}/prices/copy-from-workspace`).expect(200);
      const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return id;
    };
    const castco = await partner('CastCo');
    const metalworks = await partner('MetalWorks');
    const castcoAdmin = await partnerPerson(tenant.id, castco, 'admin');
    const castcoMember = await partnerPerson(tenant.id, castco, 'member');
    const photo = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [], partnerId: castco })).versionId;

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const lunaDesign = (await measuredDesign(prisma, tenant.id, owner.id, { customerId: luna })).versionId;
    /** One ring for Luna, offered to CastCo; accepted unless `accept` is false; due `dueIn` days from today. */
    const job = async (dueIn: number | null = null, accept = true) => {
      const quoted = await staff
        .post('/pricing/quotes', {
          product_id: cast.productId,
          options: { material: 'silver_925', finish: 'polished' },
          size: { scale: '1.5' },
          file_version_id: lunaDesign,
          quantity: 1,
          customer_id: luna,
        })
        .expect(201);
      const group = ((await staff.post('/workflow/groups', { quote_id: (quoted.body as { quote: { id: string } }).quote.id }).expect(201)).body as { id: string }).id;
      const offered = await staff.post(`/partners/jobs/${group}/offer`, { partner_id: castco }).expect(201);
      if (accept) await castcoAdmin.post(`/partner-portal/partners/${castco}/jobs/${group}/accept`).expect(200);
      await prisma.inTenant(tenant.id, (tx) =>
        tx.jobAssignment.updateMany({ where: { groupId: group }, data: { dueOn: dueIn === null ? null : new Date(`${fromToday(dueIn)}T00:00:00Z`) } }),
      );
      return { group, cost: (offered.body as { cost: string }).cost };
    };
    return { id: tenant.id, ownerId: owner.id, staff, castco, metalworks, castcoAdmin, castcoMember, photo, job, luna };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** The job's pieces still to make or made. */
  const pieces = async (tenant: Tenant, group: string) =>
    ((await tenant.castcoAdmin.get(`/partner-portal/partners/${tenant.castco}/jobs/${group}`).expect(200)).body as { work_orders: { id: string; status: string }[] })
      .work_orders.filter((piece) => piece.status !== 'scrapped')
      .map((piece) => piece.id);

  /** CastCo passes the job's pieces at each step. */
  const pass = async (tenant: Tenant, group: string, steps: string[]) => {
    const ids = await pieces(tenant, group);
    const answers: Record<string, object> = {
      polishing: { answers: [{ item: 'surface', value: 'ok' }] },
      final_qc: { answers: [{ item: 'weight', value: '5.0' }], photo_file_version_ids: [tenant.photo] },
    };
    for (const at_step of steps) {
      await tenant.castcoAdmin
        .post(`/partner-portal/partners/${tenant.castco}/moves`, { work_order_ids: ids, kind: 'pass', at_step, ...(answers[at_step] ?? {}) })
        .expect(200);
    }
    return ids;
  };
  const ALL_STEPS = ['print_pattern', 'casting_tree', 'casting', 'polishing', 'final_qc'];

  const summaryOf = async (person: Person, partnerId: string, from: string, to: string, extra = '') => {
    const response = await person.get(`/partner-portal/partners/${partnerId}/summary?from=${from}&to=${to}${extra}`).expect(200);
    expectDocumented(partnerSummaryResponseSchema, response.body);
    return response.body as Summary;
  };

  beforeAll(async () => {
    // Its own queues: no other suite's worker takes this one's measuring jobs.
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('gives an admin earnings per week, paid and owed, and the totals for both periods', async () => {
    const tenant = await freshTenant();
    // Job A: CastCo printed the pattern, then it moved to MetalWorks with 40.00 for that work. That hand-over was made
    // 14 days ago, so 40.00 became owed then; a payout has paid it.
    const a = await tenant.job();
    await pass(tenant, a.group, ['print_pattern']);
    await tenant.staff
      .post(`/partners/jobs/${a.group}/reassign`, { partner_id: tenant.metalworks, previous_owed: { amount: '40.00', reason: 'Patterns printed' } })
      .expect(201);
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.jobAssignment.updateMany({ where: { groupId: a.group, partnerId: tenant.metalworks }, data: { createdAt: new Date(Date.now() - 14 * DAY_MS) } });
      const replaced = await tx.jobAssignment.findFirstOrThrow({ where: { groupId: a.group, partnerId: tenant.castco }, select: { id: true } });
      await tx.payout.create({
        data: {
          partnerId: tenant.castco,
          amount: d('40.00'),
          currency: 'EUR',
          status: 'paid',
          providerTransferId: `tr_${randomBytes(4).toString('hex')}`,
          createdByUserId: tenant.ownerId,
          settledAt: new Date(),
          jobs: { create: { assignmentId: replaced.id, amount: d('40.00') } },
        },
      });
    });
    // Job B: finished today, owed its cost, not yet paid.
    const b = await tenant.job();
    await pass(tenant, b.group, ALL_STEPS);

    const today = fromToday(0);
    const body = await summaryOf(tenant.castcoAdmin, tenant.castco, fromToday(-59), today);
    expect(body.range).toEqual({ from: fromToday(-59), to: today, previous_from: fromToday(-119), previous_to: fromToday(-60), bucket: 'week' });
    expect(body.currency).toBe('EUR');
    expect(body.earned).toBe(d('40.00').plus(b.cost).toFixed(2));
    expect(body.previous_earned).toBe('0.00');
    const series = body.series!;
    expect(series.reduce((sum, point) => sum + point.days, 0)).toBe(60);
    expect(series.map((point) => point.start)).toEqual([...series.map((point) => point.start)].sort());
    const bucketOf = (day: string) => series.find((point) => point.start <= day && day < addDays(point.start, point.days))!;
    expect(bucketOf(fromToday(-14))).toMatchObject({ paid: '40.00', owed: '0.00' });
    expect(bucketOf(today)).toMatchObject({ paid: '0.00', owed: d(b.cost).toFixed(2) });
    // Each point is the sum of what its days hold; the points add up to `earned`.
    const sum = (key: 'paid' | 'owed') => series.reduce((total, point) => total.plus(point[key]), d('0'));
    expect(sum('paid').plus(sum('owed')).toFixed(2)).toBe(body.earned);
    expect(sum('paid').toFixed(2)).toBe('40.00');

    // The 8 days to today: only B in this period, and A's 40.00 in the 8 before it.
    const shorter = await summaryOf(tenant.castcoAdmin, tenant.castco, fromToday(-7), today);
    expect(shorter.range.bucket).toBe('day');
    expect(shorter.earned).toBe(d(b.cost).toFixed(2));
    expect(shorter.previous_earned).toBe('40.00');
    expect(shorter.series).toHaveLength(8);
    expect(shorter.jobs_finished).toBe(1);
  });

  it('gives a member the finished count and steps, without any money', async () => {
    const tenant = await freshTenant();
    const done = await tenant.job();
    await pass(tenant, done.group, ALL_STEPS);
    const running = await tenant.job();
    await pass(tenant, running.group, ['print_pattern']);

    const body = await summaryOf(tenant.castcoMember, tenant.castco, fromToday(-6), fromToday(0));
    expect(body.jobs_finished).toBe(1);
    expect(body.steps.map((step) => [step.key, step.on_track, step.late])).toEqual([['casting_tree', 1, 0]]);
    for (const key of ['earned', 'previous_earned', 'currency', 'series']) expect(body).not.toHaveProperty(key);
  });

  it('counts a job finished on the day its part ended, and again on the new day after a rework reopens it', async () => {
    const tenant = await freshTenant();
    const { group, cost } = await tenant.job();
    const tStart = new Date();
    const ids = await pass(tenant, group, ALL_STEPS);
    const tFirstDone = new Date();
    const today = fromToday(0);
    const tomorrow = fromToday(1);
    const week = [fromToday(-6), today] as const;
    const finishedIn = (from: Date, to: Date) => prisma.inTenant(tenant.id, (tx) => finishedBetween(tx, tenant.castco, from, to));
    const zeroes = (body: Summary) => body.series!.every((point) => point.paid === '0.00' && point.owed === '0.00');

    // Finished today: counted in a range holding today, in the period after it as the previous one, and nowhere else.
    expect(await summaryOf(tenant.castcoAdmin, tenant.castco, today, today)).toMatchObject({ jobs_finished: 1, previous_jobs_finished: 0 });
    expect(await summaryOf(tenant.castcoAdmin, tenant.castco, tomorrow, tomorrow)).toMatchObject({ jobs_finished: 0, previous_jobs_finished: 1 });
    expect(await summaryOf(tenant.castcoAdmin, tenant.castco, fromToday(-5), fromToday(-1))).toMatchObject({ jobs_finished: 0 });
    expect(await finishedIn(tStart, tFirstDone)).toBe(1);
    // Owed its cost.
    expect((await summaryOf(tenant.castcoAdmin, tenant.castco, ...week)).earned).toBe(d(cost).toFixed(2));

    // Staff send the ring back to polishing: the partner has work on it again, so it counts as finished
    // nowhere, and nothing is owed until it passes final QC again.
    await tenant.staff.post('/workflow/moves', { work_order_ids: ids, kind: 'correction', to_step: 'polishing', comment: 'Back for a polish' }).expect(200);
    const tCorrection = new Date();
    expect(await summaryOf(tenant.castcoAdmin, tenant.castco, today, today)).toMatchObject({ jobs_finished: 0, previous_jobs_finished: 0 });
    expect(await summaryOf(tenant.castcoAdmin, tenant.castco, tomorrow, tomorrow)).toMatchObject({ jobs_finished: 0, previous_jobs_finished: 0 });
    const reopened = await summaryOf(tenant.castcoAdmin, tenant.castco, ...week);
    expect(reopened.earned).toBe('0.00');
    expect(zeroes(reopened)).toBe(true);

    // Done again: finished at the new moment, not the first one, and owed again, in the bucket of today.
    await pass(tenant, group, ['polishing', 'final_qc']);
    const tSecondDone = new Date(Date.now() + 1000);
    expect(await finishedIn(tStart, tFirstDone)).toBe(0);
    expect(await finishedIn(tFirstDone, tCorrection)).toBe(0);
    expect(await finishedIn(tCorrection, tSecondDone)).toBe(1);
    expect(await summaryOf(tenant.castcoAdmin, tenant.castco, today, today)).toMatchObject({ jobs_finished: 1, previous_jobs_finished: 0 });
    expect(await summaryOf(tenant.castcoAdmin, tenant.castco, tomorrow, tomorrow)).toMatchObject({ jobs_finished: 0, previous_jobs_finished: 1 });
    const again = await summaryOf(tenant.castcoAdmin, tenant.castco, ...week);
    expect(again.earned).toBe(d(cost).toFixed(2));
    expect(again.series!.find((point) => point.start === today)).toMatchObject({ paid: '0.00', owed: d(cost).toFixed(2) });
    expect(again.series!.reduce((total, point) => total.plus(point.paid).plus(point.owed), d('0')).toFixed(2)).toBe(again.earned);
    // The owed moment moved with it.
    const entries = await prisma.inTenant(tenant.id, (tx) => owedBetween(tx, tStart, tSecondDone, tenant.castco));
    expect(entries.map((entry) => entry.at >= tCorrection)).toEqual([true]);
  });

  it('counts pieces at its steps now, on track and late', async () => {
    const tenant = await freshTenant();
    // Two rings at the first step, one due yesterday; one past it with no date; an offer not yet accepted, due yesterday.
    await tenant.job(-1);
    await tenant.job(0);
    const further = await tenant.job(null);
    await pass(tenant, further.group, ['print_pattern']);
    await tenant.job(-1, false);

    const body = await summaryOf(tenant.castcoAdmin, tenant.castco, fromToday(-6), fromToday(0));
    // In the order of the steps; the offer counts nowhere.
    expect(body.steps.map((step) => [step.key, step.on_track, step.late])).toEqual([
      ['print_pattern', 1, 1],
      ['casting_tree', 1, 0],
    ]);
    // Another partner sees none of them.
    const other = await partnerPerson(tenant.id, tenant.metalworks, 'admin');
    expect((await summaryOf(other, tenant.metalworks, fromToday(-6), fromToday(0))).steps).toEqual([]);
  });

  it('never names the customer, the order or the price', async () => {
    const tenant = await freshTenant();
    const { group } = await tenant.job();
    await pass(tenant, group, ALL_STEPS);
    const response = await tenant.castcoAdmin.get(`/partner-portal/partners/${tenant.castco}/summary?from=${fromToday(-6)}&to=${fromToday(0)}`).expect(200);
    expectDocumented(partnerSummaryResponseSchema, response.body);
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.push(key);
          walk(inner);
        }
      }
    };
    walk(response.body);
    expect(keys.filter((key) => /customer|order|price/i.test(key))).toEqual([]);
    expect(response.text).not.toContain('Luna Jewels');
  });

  it("answers 404 for another workspace's partner, and 400 for a range over 366 days", async () => {
    const tenant = await freshTenant();
    const stranger = await createTestTenant(prisma);
    createdTenants.push(stranger.id);
    const strangerOwner = await createTestUser(prisma, stranger.id, { roles: ['owner'] });
    const strangerStaff = as((await tokens.issueForUser(stranger.id, strangerOwner.id)).accessToken);
    const foreign = ((await strangerStaff.post('/partners', { name: 'Foreign Foundry', display_name: 'Foreign Foundry' }).expect(201)).body as { id: string }).id;

    const range = `from=${fromToday(-6)}&to=${fromToday(0)}`;
    await tenant.castcoAdmin.get(`/partner-portal/partners/${foreign}/summary?${range}`).expect(404);
    await tenant.castcoAdmin.get(`/partner-portal/partners/${tenant.metalworks}/summary?${range}`).expect(404);

    // 367 days is one too many; 366 is the longest.
    await tenant.castcoAdmin.get(`/partner-portal/partners/${tenant.castco}/summary?from=2025-01-01&to=2026-01-02`).expect(400);
    expect((await summaryOf(tenant.castcoAdmin, tenant.castco, '2025-01-01', '2026-01-01')).series).toBeDefined();
    await tenant.castcoAdmin.get(`/partner-portal/partners/${tenant.castco}/summary?from=2026-02-02&to=2026-02-01`).expect(400);
    await tenant.castcoAdmin.get(`/partner-portal/partners/${tenant.castco}/summary?${range}&bucket=week`).expect(400);
  });
});
