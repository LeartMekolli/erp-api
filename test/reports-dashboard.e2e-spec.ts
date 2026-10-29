import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { dashboardResponseSchema } from '../src/modules/reporting/dashboard-response';
import { ReportsService } from '../src/modules/reporting/reports.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Week {
  currency: string;
  orders: { placed: number; revenue?: string; average_value?: string | null };
  production: { on_time_rate: number | null; defect_rate: number | null };
  customers: { new: number; top: { id: string; name: string; revenue?: string }[]; slow_payers?: unknown[] };
  partners?: unknown;
}
interface Dashboard {
  week: { start: string; previous_start: string; computed_at: string | null };
  current: Week;
  previous: Week;
}

const WEEK_MS = 7 * 86_400_000;

/** This week against last week, computed every 15 minutes (AI 1 plan, Task 3). */
describe('reporting: the dashboard numbers', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let reports: ReportsService;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    reports = app.get(ReportsService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  /**
   * The priced cast part with tax at 19 % in Germany; Luna and Sol paying later. This week Luna and Sol
   * each order and a third order is cancelled; Luna's order last week is moved back seven days. One of
   * this week's pieces passes its first step and one fails it with a defect.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const reader = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      const role = await tx.role.create({ data: { name: 'reporter', isSystem: false } });
      await tx.rolePermission.create({ data: { roleId: role.id, permission: 'report.read' } });
      await tx.userRole.create({ data: { userId: reader.id, roleId: role.id } });
    });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);

    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const speeds = (await staff.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] };
    await staff.patch(`/pricing/delivery-speeds/${speeds.data.find((speed) => speed.key === 'standard')!.id}`, { working_days: 10 }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff
      .put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '0' }, { country: 'DE', region: null, percent: '19' }] })
      .expect(200);

    const customer = async (name: string) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      await staff.put(`/customers/${id}/payment-terms`, { terms: 'pay_later' }).expect(200);
      return id;
    };
    const luna = await customer('Luna Jewels');
    const sol = await customer('Sol Studio');

    const order = async (customerId: string, quantity: number) => {
      const quote = ((
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
      ).body as { quote: { id: string } }).quote;
      const placed = await staff
        .post('/orders', {
          customer_id: customerId,
          lines: [{ quote_id: quote.id }],
          address: { name: 'Studio', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
          shipping_method: 'courier',
        })
        .expect(201);
      const body = placed.body as { id: string; total: string; tax: { amount: string }; lines: { group_id: string }[] };
      return { id: body.id, net: new Prisma.Decimal(body.total).sub(body.tax.amount), groupId: body.lines[0].group_id };
    };

    const lunaNow = await order(luna, 10);
    const solNow = await order(sol, 12);
    const cancelled = await order(sol, 20);
    await staff.post(`/orders/${cancelled.id}/cancel`, { reason: 'Customer phoned' }).expect(200);
    const lunaLastWeek = await order(luna, 15);
    await prisma.inTenant(tenant.id, async (tx) => {
      const row = await tx.order.findUniqueOrThrow({ where: { id: lunaLastWeek.id } });
      await tx.order.update({ where: { id: row.id }, data: { placedAt: new Date(row.placedAt.getTime() - WEEK_MS) } });
    });

    const [passed, failed] = await prisma.inTenant(tenant.id, (tx) =>
      tx.workOrder.findMany({ where: { groupId: lunaNow.groupId }, orderBy: { number: 'asc' }, take: 2 }),
    );
    await staff.post('/workflow/moves', { work_order_ids: [passed.id], at_step: 'print_pattern', kind: 'pass' }).expect(200);
    await prisma.inTenant(tenant.id, (tx) =>
      tx.transition.create({
        data: {
          workOrderId: failed.id,
          kind: 'fail',
          outcome: 'rework',
          fromStepId: failed.currentStepId,
          toStepId: failed.currentStepId,
          fromStatus: 'active',
          toStatus: 'active',
          defectId: cast.workflow.defects.scratch,
          actorUserId: owner.id,
        },
      }),
    );

    return {
      id: tenant.id,
      staff,
      reader: as((await tokens.issueForUser(tenant.id, reader.id)).accessToken),
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      luna,
      sol,
      lunaNow,
      solNow,
      lunaLastWeek,
    };
  }

  it("shows the owner this week and last, the cancelled order left out, and keeps one row per week", async () => {
    const w = await workspace();
    await reports.refresh(w.id, new Date());
    await reports.refresh(w.id, new Date());

    const response = await w.staff.get('/reports/dashboard').expect(200);
    expectDocumented(dashboardResponseSchema, response.body);
    const { week, current, previous } = response.body as Dashboard;

    expect(week.previous_start < week.start).toBe(true);
    expect(current.currency).toBe('EUR');
    expect(current.orders.placed).toBe(2);
    expect(current.orders.revenue).toBe(w.lunaNow.net.add(w.solNow.net).toFixed(2));
    expect(current.orders.average_value).toBe(w.lunaNow.net.add(w.solNow.net).div(2).toFixed(2));
    expect(previous.orders.placed).toBe(1);
    expect(previous.orders.revenue).toBe(w.lunaLastWeek.net.toFixed(2));

    expect(current.production.defect_rate).toBe(0.5);
    expect(previous.production.defect_rate).toBeNull();
    expect(current.customers.new).toBe(2);
    expect(current.customers.top.map((one) => one.id).sort()).toEqual([w.luna, w.sol].sort());
    expect(current.customers.top.every((one) => typeof one.revenue === 'string')).toBe(true);
    expect(current.customers.slow_payers).toEqual([]);
    expect(current.partners).toBeDefined();

    expect(await prisma.inTenant(w.id, (tx) => tx.reportWeek.count())).toBe(2);
  });

  it('leaves money and partner figures out for a reader without payment.read and partner.read', async () => {
    const w = await workspace();
    await reports.refresh(w.id, new Date());

    const response = await w.reader.get('/reports/dashboard').expect(200);
    expectDocumented(dashboardResponseSchema, response.body);
    const { current, previous } = response.body as Dashboard;

    for (const one of [current, previous]) {
      expect(one.orders).not.toHaveProperty('revenue');
      expect(one.orders).not.toHaveProperty('average_value');
      expect(one.customers).not.toHaveProperty('slow_payers');
      expect(one.customers.top.every((customer) => !('revenue' in customer))).toBe(true);
      expect(one).not.toHaveProperty('partners');
    }
    expect(current.orders.placed).toBe(2);
  });

  it('refuses staff without report.read', async () => {
    const w = await workspace();

    await w.member.get('/reports/dashboard').expect(403);
  });

  it('answers empty weeks before the first refresh', async () => {
    const w = await workspace();

    const { current, week } = (await w.staff.get('/reports/dashboard').expect(200)).body as Dashboard;
    expect(week.computed_at).toBeNull();
    expect(current.orders.placed).toBe(0);
  });
});
