import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { rangeResponseSchema } from '../src/modules/reporting/range-response';
import type { RangeResponse } from '../src/modules/reporting/range-response';
import { ReportsService } from '../src/modules/reporting/reports.service';
import { addDays, weekMetricsSchema, weekOf } from '../src/modules/reporting/week-metrics';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { pricedCastPart } from './pricing-fixtures';

const WEEK_MS = 7 * 86_400_000;
const dateOnly = (date: string) => new Date(`${date}T00:00:00Z`);

/** The dashboard's numbers for any dates, with revenue per product (Reporting 2 plan, Task 4). */
describe('reporting: numbers for any range', () => {
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
   * This week Luna orders 10 pieces and Sol 12, and a third order of 20 is cancelled; last week Luna
   * ordered 15. Everyone pays later, so production starts at once. In UTC, the test workspace's zone.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);

    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const speeds = (await staff.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] };
    await staff.patch(`/pricing/delivery-speeds/${speeds.data.find((speed) => speed.key === 'standard')!.id}`, { working_days: 10 }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '0' }, { country: 'DE', region: null, percent: '19' }] }).expect(200);

    /** Each customer's own design: staff may quote for a customer only with that customer's files. */
    const designs = new Map<string, string>();
    const customer = async (name: string) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      await staff.put(`/customers/${id}/payment-terms`, { terms: 'pay_later' }).expect(200);
      designs.set(id, (await measuredDesign(prisma, tenant.id, owner.id, { customerId: id })).versionId);
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
            file_version_id: designs.get(customerId),
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
      const body = placed.body as { id: string; total: string; tax: { amount: string }; lines: { total: string; group_id: string }[] };
      return {
        id: body.id,
        net: new Prisma.Decimal(body.total).sub(body.tax.amount),
        lines: new Prisma.Decimal(body.lines[0].total),
        groupId: body.lines[0].group_id,
      };
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
    const product = await prisma.inTenant(tenant.id, (tx) => tx.product.findUniqueOrThrow({ where: { id: cast.productId }, select: { name: true } }));

    return { id: tenant.id, ownerId: owner.id, staff, cast, luna, sol, lunaNow, solNow, lunaLastWeek, productName: product.name };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  /** A staff member of the workspace holding exactly `permissions`, through a role of their own. */
  async function staffWith(tenantId: string, permissions: string[]) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      const role = await tx.role.create({ data: { name: `reader_${randomBytes(4).toString('hex')}`, isSystem: false } });
      await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: role.id, permission })) });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /** A workspace with only its owner: for ranges where nothing happened. */
  async function bareWorkspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    return { id: tenant.id, staff: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken) };
  }

  type Staff = ReturnType<typeof as>;
  const rangeOf = async (staff: Staff, from: string, to: string, extra = '') => {
    const response = await staff.get(`/reports/range?from=${from}&to=${to}${extra}`).expect(200);
    expectDocumented(rangeResponseSchema, response.body);
    return response.body as RangeResponse;
  };
  const sumOf = (values: (string | undefined)[]) => values.reduce((sum, value) => sum.add(value!), new Prisma.Decimal(0)).toFixed(2);
  const today = () => new Date().toISOString().slice(0, 10);

  /** The active pieces of a job, oldest first. */
  const piecesOf = (w: Workspace, groupId: string) =>
    prisma.inTenant(w.id, async (tx) =>
      (await tx.workOrder.findMany({ where: { groupId, status: 'active' }, orderBy: { number: 'asc' }, select: { id: true } })).map((piece) => piece.id),
    );
  const passAt = (w: Workspace, ids: string[], at_step: string, extra: object = {}) =>
    w.staff.post('/workflow/moves', { work_order_ids: ids, kind: 'pass', at_step, ...extra }).expect(200);

  it('answers the range, the previous period and a gap-free daily series that adds up to the range', async () => {
    const w = await workspace();
    // Fourteen days from three days ago: this week's orders in it, and last week's in the period before.
    const from = addDays(today(), -3);
    const to = addDays(today(), 10);

    const body = await rangeOf(w.staff, from, to);

    expect(body.range).toEqual({ from, to, previous_from: addDays(from, -14), previous_to: addDays(from, -1), bucket: 'day' });
    expect(body.series).toHaveLength(14);
    expect(body.series.map((point) => point.start)).toEqual(Array.from({ length: 14 }, (_, index) => addDays(from, index)));
    expect(body.series.every((point) => point.days === 1)).toBe(true);

    expect(body.current.orders.placed).toBe(2);
    expect(body.series.reduce((sum, point) => sum + point.orders_placed, 0)).toBe(body.current.orders.placed);
    expect(sumOf(body.series.map((point) => point.revenue))).toBe(body.current.orders.revenue);
    expect(body.current.orders.revenue).toBe(w.lunaNow.net.add(w.solNow.net).toFixed(2));

    expect(body.previous.orders.placed).toBe(1);
    expect(body.series.reduce((sum, point) => sum + point.previous.orders_placed, 0)).toBe(body.previous.orders.placed);
    expect(sumOf(body.series.map((point) => point.previous.revenue))).toBe(body.previous.orders.revenue);
    expect(body.previous.orders.revenue).toBe(w.lunaLastWeek.net.toFixed(2));

    // Three days ago nothing was placed.
    expect(body.series[0]).toMatchObject({ orders_placed: 0, revenue: '0.00', average_value: null, on_time_rate: null, defect_rate: null });
    expect(body.series[3]).toMatchObject({ orders_placed: 2, average_value: w.lunaNow.net.add(w.solNow.net).div(2).toFixed(2) });
  });

  it('picks week and month buckets, and bucket=day gives 366 points', async () => {
    const w = await bareWorkspace();

    // 2026-01-07 is a Wednesday: the first week holds five days of the range.
    const weeks = await rangeOf(w.staff, '2026-01-07', addDays('2026-01-07', 59));
    expect(weeks.range.bucket).toBe('week');
    expect(weeks.series[0]).toMatchObject({ start: '2026-01-07', days: 5 });
    expect(weeks.series[1]).toMatchObject({ start: '2026-01-12', days: 7 });
    expect(weeks.series.reduce((sum, point) => sum + point.days, 0)).toBe(60);
    expect(weeks.series[0]).toMatchObject({ orders_placed: 0, revenue: '0.00', average_value: null, partner_cost: '0.00' });

    const months = await rangeOf(w.staff, '2026-01-07', addDays('2026-01-07', 199));
    expect(months.range.bucket).toBe('month');
    expect(months.series[0]).toMatchObject({ start: '2026-01-07', days: 25 });
    expect(months.series.reduce((sum, point) => sum + point.days, 0)).toBe(200);

    const days = await rangeOf(w.staff, '2025-03-01', addDays('2025-03-01', 365), '&bucket=day');
    expect(days.range.bucket).toBe('day');
    expect(days.series).toHaveLength(366);

    await w.staff.get(`/reports/range?from=2025-03-01&to=${addDays('2025-03-01', 366)}`).expect(400);
    await w.staff.get('/reports/range?from=2026-03-02&to=2026-03-01').expect(400);
    await w.staff.get('/reports/range?from=2026-03-01&to=2026-03-02&bucket=week').expect(400);
  });

  it('lands an order placed just after local midnight on a DST day on that day', async () => {
    const w = await workspace();
    await prisma.inTenant(w.id, async (tx) => {
      await tx.tenant.update({ where: { id: w.id }, data: { timezone: 'Europe/Berlin' } });
      // 00:30 in Berlin on 29 March 2026, the day the clocks go forward at 02:00.
      await tx.order.update({ where: { id: w.lunaNow.id }, data: { placedAt: new Date('2026-03-28T23:30:00Z') } });
    });

    const body = await rangeOf(w.staff, '2026-03-28', '2026-03-30');

    expect(body.current.orders.placed).toBe(1);
    expect(body.series.map((point) => [point.start, point.orders_placed])).toEqual([
      ['2026-03-28', 0],
      ['2026-03-29', 1],
      ['2026-03-30', 0],
    ]);
    expect(body.series[1].revenue).toBe(w.lunaNow.net.toFixed(2));
  });

  it('counts a running range up to today, with a partial last bucket', async () => {
    const w = await workspace();
    const from = addDays(today(), -59);
    const { start } = weekOf(new Date(), 'UTC');

    const body = await rangeOf(w.staff, from, today());

    expect(body.range.bucket).toBe('week');
    const last = body.series.at(-1)!;
    // The last bucket is this week up to today: no day after today.
    expect(last.start).toBe(start);
    expect(addDays(last.start, last.days - 1)).toBe(today());
    expect(last.orders_placed).toBe(2);
    expect(body.series.reduce((sum, point) => sum + point.days, 0)).toBe(60);
    expect(body.series.reduce((sum, point) => sum + point.orders_placed, 0)).toBe(body.current.orders.placed);
    expect(body.current.orders.placed).toBe(3);
  });

  it('counts defects by kind and partner cost on the day the job became owed', async () => {
    const w = await workspace();
    const { porosity, crack } = w.cast.workflow.defects;

    // Three of Sol's pieces fail at casting: two with porosity (reworked there), one cracked (scrapped).
    const sol = (await piecesOf(w, w.solNow.groupId)).slice(0, 3);
    await passAt(w, sol, 'print_pattern');
    await passAt(w, sol, 'casting_tree');
    for (const [id, defect_id] of [[sol[0], porosity], [sol[1], porosity], [sol[2], crack]]) {
      await w.staff.post('/workflow/moves', { work_order_ids: [id], kind: 'fail', at_step: 'casting', defect_id }).expect(200);
    }

    // Luna's job is CastCo's, for 50.00; every ring goes through every step, the last one the payout step.
    await prisma.inTenant(w.id, async (tx) => {
      const partner = await tx.partner.create({ data: { name: 'CastCo Ltd', displayName: 'CastCo' } });
      await tx.jobAssignment.create({
        data: { groupId: w.lunaNow.groupId, partnerId: partner.id, kind: 'direct', status: 'accepted', cost: new Prisma.Decimal('50.00'), createdByUserId: w.ownerId },
      });
    });
    const rings = await piecesOf(w, w.lunaNow.groupId);
    const photo = (await measuredDesign(prisma, w.id, w.ownerId, { status: 'uploaded', measures: [] })).versionId;
    for (const step of ['print_pattern', 'casting_tree', 'casting']) await passAt(w, rings, step);
    await passAt(w, rings, 'polishing', { answers: [{ item: 'surface', value: 'ok' }] });
    await passAt(w, rings, 'final_qc', { answers: [{ item: 'weight', value: '5.0' }], photo_file_version_ids: [photo] });
    await passAt(w, rings, 'packing');

    const from = addDays(today(), -13);
    let body = await rangeOf(w.staff, from, today());
    expect(body.current.production.defects_by_kind).toEqual([
      { defect_id: porosity, key: 'porosity', name: 'Porosity', count: 2 },
      { defect_id: crack, key: 'crack', name: 'Crack', count: 1 },
    ]);
    expect(body.current.partners).toMatchObject({ cost: { amount: '50.00', currency: 'EUR' } });
    expect(body.series.at(-1)!.partner_cost).toBe('50.00');
    expect(sumOf(body.series.map((point) => point.partner_cost))).toBe('50.00');
    expect(body.series.at(-1)!.defect_rate).not.toBeNull();
    expect(body.previous.partners).toMatchObject({ cost: { amount: '0.00', currency: 'EUR' } });

    // Staff send a ring back before the payout step: the job isn't owed, so it counts nowhere.
    await w.staff
      .post('/workflow/moves', { work_order_ids: [rings[0]], kind: 'correction', to_step: 'polishing', comment: 'Back for a polish' })
      .expect(200);
    body = await rangeOf(w.staff, from, today());
    expect(body.current.partners).toMatchObject({ cost: { amount: '0.00', currency: 'EUR' } });
    expect(body.series.at(-1)!.partner_cost).toBe('0.00');
  });

  it('leaves money and partner cost out without payment.read, and partner cost out without partner.read', async () => {
    const w = await workspace();
    const from = addDays(today(), -3);
    const to = today();

    const reader = await rangeOf(await staffWith(w.id, ['report.read']), from, to);
    expect(reader.current.orders).toEqual({ placed: 2 });
    expect(reader.current).not.toHaveProperty('partners');
    expect(reader.previous).not.toHaveProperty('partners');
    for (const point of reader.series) {
      for (const one of [point, point.previous]) {
        for (const key of ['revenue', 'average_value', 'partner_cost']) expect(one).not.toHaveProperty(key);
      }
    }

    // Partners without money: the partner figures, but not what they cost.
    const partners = await rangeOf(await staffWith(w.id, ['report.read', 'partner.read']), from, to);
    expect(partners.current.partners).toBeDefined();
    expect(partners.current.partners).not.toHaveProperty('cost');
    expect(partners.series.every((point) => !('partner_cost' in point) && !('revenue' in point))).toBe(true);

    // Money without partners: revenue, but no partner cost.
    const money = await rangeOf(await staffWith(w.id, ['report.read', 'payment.read']), from, to);
    expect(money.current).not.toHaveProperty('partners');
    expect(money.series.every((point) => 'revenue' in point && !('partner_cost' in point))).toBe(true);

    // Both: the cost too.
    const all = await rangeOf(await staffWith(w.id, ['report.read', 'payment.read', 'partner.read']), from, to);
    expect(all.current.partners).toHaveProperty('cost');
    expect(all.series.every((point) => 'partner_cost' in point && 'partner_cost' in point.previous)).toBe(true);
  });

  it('returns the on-time target once set, null before', async () => {
    const w = await bareWorkspace();

    expect((await rangeOf(w.staff, '2026-03-01', '2026-03-07')).on_time_target).toBeNull();
    await w.staff.put('/settings/reports.targets', { onTimeRate: 0.9 }).expect(200);
    expect((await rangeOf(w.staff, '2026-03-01', '2026-03-07')).on_time_target).toBe(0.9);
  });

  it('refuses staff without report.read', async () => {
    const w = await bareWorkspace();
    const member = await createTestUser(prisma, w.id, { roles: ['member'] });

    await as((await tokens.issueForUser(w.id, member.id)).accessToken)
      .get('/reports/range?from=2026-03-01&to=2026-03-07')
      .expect(403);
  });

  it('gives the same numbers as the stored week for a Monday-to-Sunday range', async () => {
    const w = await workspace();
    const at = new Date();
    const { start, previousStart } = weekOf(at, 'UTC');
    await reports.refresh(w.id, at);
    const stored = await prisma.inTenant(w.id, (tx) => tx.reportWeek.findMany({ orderBy: { weekStart: 'asc' } }));

    for (const [week, row] of [previousStart, start].map((day, index) => [day, stored[index]] as const)) {
      const range = await reports.metricsFor(w.id, { from: week, to: addDays(week, 6) }, at);
      const { by_product: _byProduct, by_customer_group: _byGroup, ...orders } = range.orders;
      const { defects_by_kind: _defects, ...production } = range.production;
      const { cost: _cost, ...partners } = range.partners;
      expect({ ...range, orders, production, partners }).toEqual(weekMetricsSchema.parse(row.data));
    }
  });

  it('adds up a fortnight across weeks, with revenue per product', async () => {
    const w = await workspace();
    const { start, previousStart } = weekOf(new Date(), 'UTC');

    const range = await reports.metricsFor(w.id, { from: previousStart, to: addDays(start, 6) });

    // The cancelled order is left out.
    expect(range.orders.placed).toBe(3);
    expect(range.orders.revenue).toBe(w.lunaNow.net.add(w.solNow.net).add(w.lunaLastWeek.net).toFixed(2));
    expect(range.orders.by_product).toEqual([
      { product_id: w.cast.productId, name: w.productName, quantity: 37, revenue: w.lunaNow.lines.add(w.solNow.lines).add(w.lunaLastWeek.lines).toFixed(2) },
    ]);
    expect(range.customers.new).toBe(2);

    // Only last week: Luna's order of 15.
    const lastWeek = await reports.metricsFor(w.id, { from: previousStart, to: addDays(previousStart, 6) });
    expect(lastWeek.orders.by_product).toEqual([
      { product_id: w.cast.productId, name: w.productName, quantity: 15, revenue: w.lunaLastWeek.lines.toFixed(2) },
    ]);
  });

  it('takes slow payers and partner load as at the last day', async () => {
    const w = await workspace();
    const { previousStart } = weekOf(new Date(), 'UTC');
    const partner = await prisma.inTenant(w.id, async (tx) => {
      const created = await tx.partner.create({ data: { name: 'CastCo Ltd', displayName: 'CastCo' } });
      await tx.partnerCapacitySnapshot.create({
        data: { date: dateOnly(addDays(previousStart, 2)), partnerId: created.id, stepTypeId: w.cast.steps.casting, load: 30, capacity: 100, capacityPeriod: 'week' },
      });
      // Luna's invoice from last week, due on its Wednesday and still open.
      await tx.invoice.create({
        data: {
          orderId: w.lunaLastWeek.id,
          providerInvoiceId: 'in_late',
          url: 'https://invoices.example.test/in_late',
          linesAmount: new Prisma.Decimal('100.00'),
          shipping: new Prisma.Decimal('0.00'),
          tax: new Prisma.Decimal('0.00'),
          total: new Prisma.Decimal('100.00'),
          currency: 'EUR',
          dueOn: dateOnly(addDays(previousStart, 2)),
          status: 'open',
        },
      });
      return created;
    });

    // Last week, judged at its Sunday: the snapshot's load, and the invoice overdue.
    const lastWeek = await reports.metricsFor(w.id, { from: previousStart, to: addDays(previousStart, 6) });
    expect(lastWeek.partners.load).toEqual([{ id: partner.id, name: 'CastCo Ltd', percent: 30 }]);
    expect(lastWeek.customers.slow_payers).toEqual([{ id: w.luna, name: 'Luna Jewels', overdue: '100.00' }]);

    // Its Monday and Tuesday only: before the snapshot's day, and before the invoice was due.
    const early = await reports.metricsFor(w.id, { from: previousStart, to: addDays(previousStart, 1) });
    expect(early.partners.load).toEqual([]);
    expect(early.customers.slow_payers).toEqual([]);
  });
});
