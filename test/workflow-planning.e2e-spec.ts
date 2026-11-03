import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { stepCapacitiesResponseSchema, stepPlanResponseSchema } from '../src/modules/workflow/planning/planning-response';
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
interface Item {
  group_id: string;
  band: { key: string };
  pieces: number;
  planned_on: string;
  promised_on: string;
}
interface Plan {
  date: string;
  daily_pieces: number | null;
  planned: Item[];
  late: Item[];
  next: Item[];
  over_capacity: { date: string; pieces: number; daily_pieces: number; suggestion: string }[];
}

const PRIORITY = {
  weights: { lifetime: 1, recent: 1, frequency: 1, payment: 1 },
  defaultBand: { key: 'standard', name: 'Standard' },
  bands: [{ key: 'gold', name: 'Gold', from: 80, firstInLine: true, mayPickPartner: false }],
};
const DAY_MS = 86_400_000;

/**
 * Production planning (Orders 3b plan, Task 2): each in-house step type's work for a day, planned back
 * from promised dates within its daily capacity, the band in force first. Every day is a working day
 * here, so the dates below hold whatever day the suite runs.
 */
describe('workflow: the plan for a day', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  /** The cast part made wholly in-house, every day a working day, and orders of pay-later customers. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });

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
          done_by: 'workspace',
        })),
      })
      .expect(200);
    await staff.put('/settings/business.calendar', { workingDays: [1, 2, 3, 4, 5, 6, 7], startHour: 8, endHour: 24, closedDates: [] }).expect(200);
    await staff.put('/settings/customers.priority', PRIORITY).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '0' }] }).expect(200);

    const customer = async (name: string) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      await staff.put(`/customers/${id}/payment-terms`, { terms: 'pay_later' }).expect(200);
      return id;
    };
    /** An order of `quantity` silver polished pieces, promised on `promisedOn`; answers its group. */
    const order = async (customerId: string, quantity: number, promisedOn: string) => {
      const quote = (
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
      ).quote;
      const placed = (
        await staff
          .post('/orders', {
            customer_id: customerId,
            lines: [{ quote_id: quote.id }],
            address: { name: 'Studio', line1: 'Main street 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
            shipping_method: 'courier',
          })
          .expect(201)
      ).body as { id: string; lines: { group_id: string }[] };
      await prisma.inTenant(tenant.id, (tx) => tx.order.update({ where: { id: placed.id }, data: { promisedOn: new Date(`${promisedOn}T00:00:00Z`) } }));
      return placed.lines[0].group_id;
    };

    const finalQc = cast.workflow.notPriced.finalQc;
    const plan = async (date?: string): Promise<Plan> => {
      const response = await staff.get(`/workflow/plan?step_type_id=${finalQc}${date ? `&date=${date}` : ''}`).expect(200);
      expectDocumented(stepPlanResponseSchema, response.body);
      return response.body as Plan;
    };
    const today = (await plan()).date;
    const day = (offset: number) => new Date(new Date(`${today}T00:00:00Z`).getTime() + offset * DAY_MS).toISOString().slice(0, 10);

    return { id: tenant.id, staff, member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken), finalQc, customer, order, plan, day };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('plans final QC by priority, and flags a day past capacity (Done when 5)', async () => {
    const w = await workspace();
    await w.staff.put(`/workflow/step-types/${w.finalQc}/capacity`, { daily_pieces: 5 }).expect(200);
    const capacities = await w.staff.get('/workflow/capacities').expect(200);
    expectDocumented(stepCapacitiesResponseSchema, capacities.body);

    const gold = await w.customer('Sol Studio');
    await w.staff.put(`/customers/${gold}/priority/override`, { band_key: 'gold', reason: 'First in line', ends_on: w.day(30) }).expect(200);
    const goldGroup = await w.order(gold, 2, w.day(10));
    const later = await w.order(await w.customer('Luna Jewels'), 4, w.day(10));
    const sooner = await w.order(await w.customer('Mare Atelier'), 1, w.day(9));
    const rush = await w.order(await w.customer('Nova Rings'), 30, w.day(5));

    // Packing on the promised day, final QC the day before; the Gold group's pieces first.
    const ninth = await w.plan(w.day(9));
    expect(ninth.daily_pieces).toBe(5);
    expect(ninth.planned.map((item) => [item.group_id, item.pieces])).toEqual([
      [goldGroup, 2],
      [later, 3],
    ]);
    expect(ninth.planned[0].band.key).toBe('gold');
    // Within a band, the earlier promise first.
    expect((await w.plan(w.day(8))).planned.map((item) => [item.group_id, item.pieces])).toEqual([
      [sooner, 1],
      [later, 1],
    ]);

    // 30 pieces against 5 a day from today to the day before their promise: today takes 10.
    const now = await w.plan();
    expect(now.late.map((item) => item.group_id)).toContain(rush);
    expect(now.over_capacity[0]).toEqual({
      date: w.day(0),
      pieces: 10,
      daily_pieces: 5,
      suggestion: '10 pieces planned against 5: consider offering some of this work to a workshop.',
    });
  });

  it('never moves or blocks work', async () => {
    const w = await workspace();
    await w.staff.put(`/workflow/step-types/${w.finalQc}/capacity`, { daily_pieces: 1 }).expect(200);
    const group = await w.order(await w.customer('Luna Jewels'), 3, w.day(10));
    const before = await w.plan(w.day(9));
    const pieces = await prisma.inTenant(w.id, (tx) => tx.workOrder.findMany({ where: { groupId: group }, orderBy: { id: 'asc' } }));
    await w.staff.post('/workflow/moves', { work_order_ids: [pieces[0].id], at_step: 'print_pattern', kind: 'pass' }).expect(200);
    expect((await w.plan(w.day(9))).planned).toEqual(before.planned);
  });

  it('plans without a limit once the capacity is removed', async () => {
    const w = await workspace();
    await w.staff.put(`/workflow/step-types/${w.finalQc}/capacity`, { daily_pieces: 5 }).expect(200);
    await w.order(await w.customer('Nova Rings'), 30, w.day(5));
    expect((await w.plan()).over_capacity).toHaveLength(1);

    await w.staff.put(`/workflow/step-types/${w.finalQc}/capacity`, { daily_pieces: null }).expect(200);
    const unlimited = await w.plan(w.day(4));
    expect(unlimited.daily_pieces).toBeNull();
    expect(unlimited.over_capacity).toEqual([]);
    expect(unlimited.planned.map((item) => item.pieces)).toEqual([30]);
  });

  it('refuses a capacity of 0, and a member changing it', async () => {
    const w = await workspace();
    await w.staff.put(`/workflow/step-types/${w.finalQc}/capacity`, { daily_pieces: 0 }).expect(400);
    await w.member.put(`/workflow/step-types/${w.finalQc}/capacity`, { daily_pieces: 5 }).expect(403);
    await w.staff.get('/workflow/plan?step_type_id=not-an-id').expect(400);
  });
});
