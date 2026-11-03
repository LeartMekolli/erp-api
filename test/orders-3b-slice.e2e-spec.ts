import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AI_PROVIDER } from '../src/modules/ai/ai-provider';
import { fakeToolUse } from '../src/modules/ai/fake-ai-provider';
import type { FakeAiProvider } from '../src/modules/ai/fake-ai-provider';
import { JobSummaryService } from '../src/modules/ai/job-summary/job-summary.service';
import { RunsService } from '../src/modules/ai/runs.service';
import { CourierEventsService } from '../src/modules/couriers/courier-events.service';
import { signFakeCourierEvent } from '../src/modules/couriers/fake-courier-provider';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { measuredDesign } from './catalog-fixtures';
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
interface Order {
  id: string;
  state: string;
  shipping: { price: string; courier: string | null; tracking: string | null; label: { url: string; tracking: string; tracking_status: string | null } | null };
  lines: { group_id: string }[];
}
interface PlanItem {
  group_id: string;
  band: { key: string };
  pieces: number;
}
interface Plan {
  date: string;
  planned: PlanItem[];
  late: PlanItem[];
  over_capacity: { date: string; pieces: number; daily_pieces: number; suggestion: string }[];
}

const SUMMARY = {
  description: 'Ten polished silver cast parts.',
  watch_outs: ['Porosity showed at polishing on your last job', 'Final QC found scratches on this product'],
  recommendations: ['Degas the melt before casting', 'Wrap each piece before packing'],
  production_days: 6,
  used_history: true,
};
const ACCOUNT = {
  api_key: 'EZTKtest_secret_key_123',
  webhook_secret: 'whsec_courier_test',
  from_address: { name: 'Sol Studio', line1: 'Main street 2', city: 'Munich', postal_code: '80331', country: 'DE' },
};
const PARCEL = { weight_g: 1_200, length_cm: 20, width_cm: 15, height_cm: 10 };
const ADDRESS = { name: 'Studio', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
const PRIORITY = {
  weights: { lifetime: 1, recent: 1, frequency: 1, payment: 1 },
  defaultBand: { key: 'standard', name: 'Standard' },
  bands: [{ key: 'gold', name: 'Gold', from: 80, firstInLine: true, mayPickPartner: false }],
};
const SETUP_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Orders 3b in one workspace (Orders 3 spec, "Done when" 4–6): a workshop accepts a job and gets a summary
 * from its own past jobs and the workspace's final QC, nothing from another workshop; staff open final
 * QC's plan, the first-in-line customer first and a day past capacity flagged; and an order quoted with a
 * live-rate courier method is shipped with a bought label and marked delivered by the courier's tracking.
 * AI runs and courier events are executed here, under a queue prefix no worker reads. Every day is a
 * working day, so the dates hold whatever day the suite runs.
 */
describe('Orders 3b: job summaries, production planning and couriers', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let summaries: JobSummaryService;
  let runs: RunsService;
  let events: CourierEventsService;
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
    events = app.get(CourierEventsService);
    fake = app.get<FakeAiProvider>(AI_PROVIDER);
  }, SETUP_MS);

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('summarises a job for its workshop, plans final QC, and ships with a label the courier marks delivered', async () => {
    // The cast part, made by workshops up to final QC and packing, which are done in-house.
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
    await staff.put('/settings/business.calendar', { workingDays: [1, 2, 3, 4, 5, 6, 7], startHour: 8, endHour: 24, closedDates: [] }).expect(200);
    await staff.put('/settings/customers.priority', PRIORITY).expect(200);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '19' }] }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    // The workspace's courier account, and a method priced by it.
    await staff.put('/couriers/account', ACCOUNT).expect(200);
    await staff
      .post('/orders/shipping-methods', { key: 'live', name: 'Tracked courier', live_rate: { carrier: 'FakeCarrier', service: 'standard' }, default_parcel: PARCEL })
      .expect(201);
    await prisma.inTenant(tenant.id, (tx) => tx.tenant.update({ where: { id: tenant.id }, data: { aiMonthlyLimitUsd: new Prisma.Decimal('5.00') } }));

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
      const user = await createTestUser(prisma, tenant.id, { roles: [] });
      await prisma.inTenant(tenant.id, async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { kind: 'partner' } });
        await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'partner', organisationId: id, role: 'member' } });
      });
      return { id, person: as((await tokens.issueForUser(tenant.id, user.id)).accessToken) };
    };
    const castco = await partner('CastCo');
    const other = await partner('Other Works');

    const customer = async (name: string) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      await staff.put(`/customers/${id}/payment-terms`, { terms: 'pay_later' }).expect(200);
      return id;
    };
    const luna = await customer('Luna Jewels');
    const viewerUser = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.user.update({ where: { id: viewerUser.id }, data: { kind: 'customer' } });
      await tx.organisationMembership.create({ data: { userId: viewerUser.id, organisationType: 'customer', organisationId: luna, role: 'viewer' } });
    });
    const viewer = as((await tokens.issueForUser(tenant.id, viewerUser.id)).accessToken);

    const quote = async (customerId: string, quantity: number) =>
      (
        (
          await staff
            .post('/pricing/quotes', {
              product_id: cast.productId,
              options: { material: 'silver_925', finish: 'polished' },
              size: { scale: '1.5' },
              quantity,
              file_version_id: cast.versionId,
              customer_id: customerId,
            })
            .expect(201)
        ).body as { quote: { id: string } }
      ).quote.id;
    /** An order promised on `promisedOn`, written as staff agreeing a date would. */
    const order = async (customerId: string, quantity: number, promisedOn: string, method = 'courier'): Promise<Order> => {
      const placed = (
        await staff.post('/orders', { customer_id: customerId, lines: [{ quote_id: await quote(customerId, quantity) }], address: ADDRESS, shipping_method: method }).expect(201)
      ).body as Order;
      await prisma.inTenant(tenant.id, (tx) => tx.order.update({ where: { id: placed.id }, data: { promisedOn: new Date(`${promisedOn}T00:00:00Z`) } }));
      return placed;
    };
    /** A job of a quote's group, offered to and accepted by `by`, handed over 3 days ago. */
    const pastJob = async (by: { id: string; person: Client }) => {
      const group = ((await staff.post('/workflow/groups', { quote_id: await quote(luna, 10) }).expect(201)).body as { id: string }).id;
      await staff.post(`/partners/jobs/${group}/offer`, { partner_id: by.id }).expect(201);
      await by.person.post(`/partner-portal/partners/${by.id}/jobs/${group}/accept`).expect(200);
      const long = new Date(Date.now() - 3 * DAY_MS);
      await prisma.inTenant(tenant.id, (tx) => tx.jobAssignment.updateMany({ where: { groupId: group }, data: { createdAt: long, respondedAt: long } }));
      return group;
    };
    /** A failed check of the group's first piece at `stepKey`, counted for `partnerId` (null: the workspace's own step). */
    const fail = (group: string, stepKey: string, defectId: string, partnerId: string | null) =>
      prisma.inTenant(tenant.id, async (tx) => {
        const piece = await tx.workOrder.findFirstOrThrow({ where: { groupId: group }, orderBy: { id: 'asc' }, include: { group: { select: { workflowVersionId: true } } } });
        const step = await tx.workflowStep.findFirstOrThrow({ where: { versionId: piece.group.workflowVersionId, key: stepKey } });
        await tx.transition.create({
          data: {
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

    const finalQc = cast.workflow.notPriced.finalQc;
    const plan = async (date?: string): Promise<Plan> =>
      (await staff.get(`/workflow/plan?step_type_id=${finalQc}${date ? `&date=${date}` : ''}`).expect(200)).body as Plan;
    const today = (await plan()).date;
    const day = (offset: number) => new Date(new Date(`${today}T00:00:00Z`).getTime() + offset * DAY_MS).toISOString().slice(0, 10);

    // Done when 6, first half: the order is quoted with the live-rate method, and priced by the courier.
    const rates = (await staff.post('/orders/shipping-rates', { customer_id: luna, address: ADDRESS }).expect(200)).body as {
      data: { key: string; price: string | null; available: boolean }[];
    };
    expect(rates.data.find((rate) => rate.key === 'live')).toMatchObject({ price: '6.90', available: true });
    const shipped = await order(luna, 10, day(40), 'live');
    expect(shipped.shipping.price).toBe('6.90');

    // Done when 4: CastCo's past job had porosity at its own polishing; Other Works' had a crack at its
    // own, and the workspace's final QC found a scratch on it. CastCo accepts the order's job.
    const { porosity, crack, scratch } = cast.workflow.defects;
    await fail(await pastJob(castco), 'polishing', porosity, castco.id);
    const others = await pastJob(other);
    await fail(others, 'polishing', crack, other.id);
    await fail(others, 'final_qc', scratch, null);
    const group = shipped.lines[0].group_id;
    await staff.post(`/partners/jobs/${group}/offer`, { partner_id: castco.id }).expect(201);
    await castco.person.post(`/partner-portal/partners/${castco.id}/jobs/${group}/accept`).expect(200);

    expect(await summaries.queueDue(tenant.id, new Date())).toBe(1);
    const [row] = await prisma.inTenant(tenant.id, (tx) => tx.jobSummary.findMany());
    fake.script(fakeToolUse('job_summary', SUMMARY));
    await runs.execute(tenant.id, row.runId);
    const prompt = JSON.stringify(fake.calls.at(-1));
    expect(prompt).toContain('Porosity');
    expect(prompt).toContain('Scratch');
    for (const hidden of ['Other Works', 'Crack', 'Luna Jewels', 'Seen by the inspector']) {
      expect(prompt).not.toContain(hidden);
    }
    const detail = await castco.person.get(`/partner-portal/partners/${castco.id}/jobs/${group}`).expect(200);
    expect((detail.body as { summary: object | null }).summary).toMatchObject({ status: 'done', ...SUMMARY });

    // Done when 5: final QC takes 5 pieces a day. The Gold customer's pieces come first, then the
    // earlier promise; 30 pieces due in 5 days put 10 on today, flagged with the suggestion.
    await staff.put(`/workflow/step-types/${finalQc}/capacity`, { daily_pieces: 5 }).expect(200);
    const gold = await customer('Sol Studio');
    await staff.put(`/customers/${gold}/priority/override`, { band_key: 'gold', reason: 'First in line', ends_on: day(30) }).expect(200);
    const goldGroup = (await order(gold, 2, day(10))).lines[0].group_id;
    const later = (await order(await customer('Mare Atelier'), 4, day(10))).lines[0].group_id;
    const sooner = (await order(await customer('Nova Rings'), 1, day(9))).lines[0].group_id;
    const rush = (await order(await customer('Rio Works'), 30, day(5))).lines[0].group_id;

    const ninth = await plan(day(9));
    expect(ninth.planned.map((item) => [item.group_id, item.pieces])).toEqual([
      [goldGroup, 2],
      [later, 3],
    ]);
    expect(ninth.planned[0].band.key).toBe('gold');
    expect((await plan(day(8))).planned.map((item) => [item.group_id, item.pieces])).toEqual([
      [sooner, 1],
      [later, 1],
    ]);
    const now = await plan();
    expect(now.late.map((item) => item.group_id)).toContain(rush);
    expect(now.over_capacity[0]).toEqual({
      date: today,
      pieces: 10,
      daily_pieces: 5,
      suggestion: '10 pieces planned against 5: consider offering some of this work to a workshop.',
    });

    // Done when 6, second half: once every piece is finished, staff ship with a bought label, and the
    // courier's tracking update marks the order delivered. Moving pieces through every step is Workflow's to test.
    await prisma.inTenant(tenant.id, (tx) => tx.workOrder.updateMany({ where: { groupId: group }, data: { status: 'finished', currentStepId: null } }));
    const sent = (await staff.post(`/orders/${shipped.id}/ship`, { label: {} }).expect(200)).body as Order;
    const label = sent.shipping.label!;
    expect(sent).toMatchObject({ state: 'shipped', shipping: { courier: 'FakeCarrier', tracking: label.tracking } });
    expect(label.url).toMatch(/^https:\/\/labels\.example\.test\//);

    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, description: 'tracker.updated', result: { tracking_code: label.tracking, status: 'delivered' } });
    await http()
      .post(`/webhooks/couriers/${tenant.id}`)
      .set('Content-Type', 'application/json')
      .set('X-Hmac-Signature', signFakeCourierEvent(Buffer.from(body), ACCOUNT.webhook_secret))
      .send(body)
      .expect(200);
    const stored = await prisma.inTenant(tenant.id, (tx) => tx.courierEvent.findFirstOrThrow({ where: { providerEventId: eventId } }));
    await events.apply(tenant.id, stored.id);

    expect(((await staff.get(`/orders/${shipped.id}`).expect(200)).body as Order).state).toBe('delivered');
    const told = await prisma.inTenant(tenant.id, (tx) => tx.notification.findMany({ where: { subjectType: 'order', subjectId: shipped.id, eventKey: 'order.delivered' } }));
    expect(told).toHaveLength(1);
    const seen = await viewer.get(`/portal/customers/${luna}/orders/${shipped.id}`).expect(200);
    expect(seen.body).toMatchObject({ state: 'delivered', shipping: { tracking: label.tracking, tracking_status: 'delivered' } });
  });
});
