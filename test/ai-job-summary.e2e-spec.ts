import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AI_PROVIDER } from '../src/modules/ai/ai-provider';
import { fakeToolUse } from '../src/modules/ai/fake-ai-provider';
import type { FakeAiProvider } from '../src/modules/ai/fake-ai-provider';
import { JobSummaryService } from '../src/modules/ai/job-summary/job-summary.service';
import { RunsService } from '../src/modules/ai/runs.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import type { TenantAuth } from '../src/modules/identity/auth-context';
import { TENANT_PERMISSIONS } from '../src/modules/identity/permissions';
import { jobSummaryResponseSchema } from '../src/modules/partners/job-summary-response';
import { partnerJobDetailResponseSchema } from '../src/modules/partners/partner-response';
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
  status: string;
  description: string | null;
  watch_outs: string[] | null;
  recommendations: string[] | null;
  production_days: number | null;
  used_history: boolean | null;
}

const SUMMARY = {
  description: 'Ten polished silver cast parts.',
  watch_outs: ['Porosity showed at polishing on your last job', 'Final QC found scratches on this product'],
  recommendations: ['Degas the melt before casting', 'Wrap each piece before packing'],
  production_days: 6,
  used_history: true,
};
const SETUP_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The partner job summary (Orders 3b plan, Task 1): written when a workshop gets a job, from the job, the
 * workshop's own history and the workspace's own findings, never another workshop's. Runs are executed
 * here, in the app, with a queue prefix no worker reads, so the app's fake answers.
 */
describe('ai: the partner job summary', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let summaries: JobSummaryService;
  let runs: RunsService;
  let fake: FakeAiProvider;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });
  type Client = ReturnType<typeof as>;

  async function partnerPerson(tenantId: string, partnerId: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind: 'partner' } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'partner', organisationId: partnerId, role: 'member' } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /**
   * The priced cast part with final QC and packing done in-house; CastCo and Other Works approved for the
   * partner steps; Luna Jewels as the customer; a $5 AI limit unless `ai` is false.
   */
  async function workspace(options: { ai?: boolean } = {}) {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
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
          done_by: step.key === 'final_qc' || step.key === 'packing' ? 'workspace' : 'partner',
        })),
      })
      .expect(200);

    const partner = async (name: string) => {
      const id = ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
      await staff
        .put(`/partners/${id}/capabilities`, {
          capabilities: [printPattern, castingTree, casting, polishing].map((step_type_id) => ({ step_type_id, capacity: 200, capacity_period: 'week' })),
        })
        .expect(200);
      await staff.put(`/partners/${id}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
      await staff.post(`/partners/${id}/prices/copy-from-workspace`).expect(200);
      const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return { id, person: await partnerPerson(tenant.id, id) };
    };
    const castco = await partner('CastCo');
    const other = await partner('Other Works');
    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    if (options.ai !== false) {
      await prisma.inTenant(tenant.id, (tx) => tx.tenant.update({ where: { id: tenant.id }, data: { aiMonthlyLimitUsd: new Prisma.Decimal('5.00') } }));
    }

    /** A job of 10 silver polished pieces, accepted by `by`. */
    const job = async (by: { id: string; person: Client }) => {
      const quote = (
        (
          await staff
            .post('/pricing/quotes', {
              product_id: cast.productId,
              options: { material: 'silver_925', finish: 'polished' },
              size: { scale: '1.5' },
              file_version_id: cast.versionId,
              quantity: 10,
              customer_id: luna,
            })
            .expect(201)
        ).body as { quote: { id: string } }
      ).quote;
      const group = ((await staff.post('/workflow/groups', { quote_id: quote.id }).expect(201)).body as { id: string }).id;
      await staff.post(`/partners/jobs/${group}/offer`, { partner_id: by.id }).expect(201);
      await by.person.post(`/partner-portal/partners/${by.id}/jobs/${group}/accept`).expect(200);
      return group;
    };

    /** Takes a job out of the sweep's 24 hours, as one handed over long ago. */
    const age = (group: string) =>
      prisma.inTenant(tenant.id, (tx) =>
        tx.jobAssignment.updateMany({ where: { groupId: group }, data: { createdAt: new Date(Date.now() - 3 * DAY_MS), respondedAt: new Date(Date.now() - 3 * DAY_MS) } }),
      );

    /** A failed check of the group's first piece at `stepKey`, counted for `partnerId` (null: the workspace's own step). */
    const fail = async (group: string, stepKey: string, defectId: string, partnerId: string | null) =>
      prisma.inTenant(tenant.id, async (tx) => {
        const piece = await tx.workOrder.findFirstOrThrow({ where: { groupId: group }, orderBy: { id: 'asc' }, include: { group: { select: { workflowVersionId: true } } } });
        const step = await tx.workflowStep.findFirstOrThrow({ where: { versionId: piece.group.workflowVersionId, key: stepKey } });
        await tx.transition.create({
          data: {
            moveId: newId(),
            workOrderId: piece.id,
            kind: 'fail',
            outcome: 'rework',
            fromStepId: step.id,
            toStepId: step.id,
            fromStatus: 'active',
            toStatus: 'active',
            defectId,
            comment: 'Seen by the inspector at Other Works',
            actorUserId: owner.id,
            partnerId,
          },
        });
      });

    /** The summary rows of the workspace, oldest first. */
    const rows = () => prisma.inTenant(tenant.id, (tx) => tx.jobSummary.findMany({ orderBy: { createdAt: 'asc' } }));

    return { id: tenant.id, owner, staff, cast, castco, other, job, age, fail, rows };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const portalSummary = async (w: Workspace, group: string): Promise<Summary | null> => {
    const detail = await w.castco.person.get(`/partner-portal/partners/${w.castco.id}/jobs/${group}`).expect(200);
    expectDocumented(partnerJobDetailResponseSchema, detail.body);
    return (detail.body as { summary: Summary | null }).summary;
  };

  /** Runs each summary row's run here, answering `answer` for each. */
  const runAll = async (w: Workspace, answer: object = SUMMARY) => {
    for (const row of await w.rows()) {
      fake.script(fakeToolUse('job_summary', answer));
      await runs.execute(w.id, row.runId);
    }
  };

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    summaries = app.get(JobSummaryService);
    runs = app.get(RunsService);
    fake = app.get<FakeAiProvider>(AI_PROVIDER);
  }, SETUP_MS);

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it("writes a summary when a workshop accepts a job, from its own history and the workspace's findings (Done when 4)", async () => {
    const w = await workspace();
    const { porosity, crack, scratch } = w.cast.workflow.defects;
    const earlier = await w.job(w.castco);
    await w.fail(earlier, 'polishing', porosity, w.castco.id);
    const others = await w.job(w.other);
    await w.fail(others, 'polishing', crack, w.other.id);
    await w.fail(others, 'final_qc', scratch, null);
    await w.age(earlier);
    await w.age(others);

    const group = await w.job(w.castco);
    expect(await summaries.queueDue(w.id, new Date())).toBe(1);
    await runAll(w);

    const prompt = JSON.stringify(fake.calls.at(-1));
    expect(prompt).toContain('Porosity');
    expect(prompt).toContain('Scratch');
    expect(prompt).toContain('Surface');
    for (const hidden of ['Other Works', 'Crack', 'Luna Jewels', 'Seen by the inspector']) {
      expect(prompt).not.toContain(hidden);
    }
    const cost = await prisma.inTenant(w.id, (tx) => tx.jobAssignment.findFirstOrThrow({ where: { groupId: group, status: 'accepted' } }));
    expect(prompt).not.toContain(cost.cost.toFixed(2));

    expect(await portalSummary(w, group)).toMatchObject({ status: 'done', ...SUMMARY });
    const staffView = await w.staff.get(`/partners/jobs/${group}/summary`).expect(200);
    expectDocumented(jobSummaryResponseSchema, staffView.body);
    expect(staffView.body).toMatchObject({ status: 'done', production_days: 6 });
  });

  it('says so when the workshop has no history', async () => {
    const w = await workspace();
    await w.job(w.castco);
    expect(await summaries.queueDue(w.id, new Date())).toBe(1);
    await runAll(w, { ...SUMMARY, used_history: false });
    // The facts are JSON inside the system prompt, so read it as written.
    expect(fake.calls.at(-1)!.system).toContain('"own_history":{"jobs":0');
  });

  it('writes one summary per job, and again when staff ask', async () => {
    const w = await workspace();
    const group = await w.job(w.castco);
    expect(await summaries.queueDue(w.id, new Date())).toBe(1);
    expect(await summaries.queueDue(w.id, new Date())).toBe(0);
    await runAll(w);

    const again = await w.staff.post(`/partners/jobs/${group}/summary`).expect(201);
    expectDocumented(jobSummaryResponseSchema, again.body);
    expect(again.body).toMatchObject({ status: 'pending' });
    await w.staff.post(`/partners/jobs/${group}/summary`).expect(409);
    expect(await w.rows()).toHaveLength(2);
    expect(await summaries.queueDue(w.id, new Date())).toBe(0);
  });

  it('writes again when a summary was never run', async () => {
    const w = await workspace();
    const group = await w.job(w.castco);
    expect(await summaries.queueDue(w.id, new Date())).toBe(1);
    // As when its run never reached the queue: past the hour a run may wait, it is never run, and reads failed.
    // AI runs are insert-only, so the clock moves instead; the service is called as staff, since a token would expire.
    const auth: TenantAuth = {
      scope: 'tenant',
      tenantId: w.id,
      userId: w.owner.id,
      jti: 'test',
      expiresAt: new Date(Date.now() + 3 * 3_600_000),
      permissions: new Set(TENANT_PERMISSIONS),
    };
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 3_600_000);
    try {
      await expect(summaries.get(w.id, group)).resolves.toMatchObject({ status: 'failed' });
      await summaries.rewrite(auth, group);
    } finally {
      jest.restoreAllMocks();
    }
    expect(await w.rows()).toHaveLength(2);
  });

  it('writes none when switched off or AI is not set up', async () => {
    const off = await workspace();
    await off.staff.put('/settings/ai.jobSummary', { enabled: false }).expect(200);
    const group = await off.job(off.castco);
    expect(await summaries.queueDue(off.id, new Date())).toBe(0);
    expect(await portalSummary(off, group)).toBeNull();
    await off.staff.post(`/partners/jobs/${group}/summary`).expect(409);

    const noAi = await workspace({ ai: false });
    const other = await noAi.job(noAi.castco);
    expect(await summaries.queueDue(noAi.id, new Date())).toBe(0);
    expect(await portalSummary(noAi, other)).toBeNull();
  });

  it('writes one for a direct job and for a moved job', async () => {
    const w = await workspace();
    const direct = await w.job(w.castco);
    const moved = await w.job(w.castco);
    await w.age(direct);
    await w.age(moved);
    // As a customer's pick and a move between workshops leave them: accepted at once, never offered.
    await prisma.inTenant(w.id, async (tx) => {
      await tx.jobAssignment.updateMany({ where: { groupId: direct }, data: { kind: 'direct', respondedAt: null, createdAt: new Date() } });
      await tx.jobAssignment.updateMany({ where: { groupId: moved }, data: { kind: 'reassign', respondedAt: null, createdAt: new Date() } });
    });
    expect(await summaries.queueDue(w.id, new Date())).toBe(2);
  });
});
