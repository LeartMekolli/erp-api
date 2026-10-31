import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { ReportsService } from '../src/modules/reporting/reports.service';
import { addDays, weekMetricsSchema, weekOf } from '../src/modules/reporting/week-metrics';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
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
      const body = placed.body as { id: string; total: string; tax: { amount: string }; lines: { total: string }[] };
      return { id: body.id, net: new Prisma.Decimal(body.total).sub(body.tax.amount), lines: new Prisma.Decimal(body.lines[0].total) };
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

    return { id: tenant.id, cast, luna, sol, lunaNow, solNow, lunaLastWeek, productName: product.name };
  }

  it('gives the same numbers as the stored week for a Monday-to-Sunday range', async () => {
    const w = await workspace();
    const at = new Date();
    const { start, previousStart } = weekOf(at, 'UTC');
    await reports.refresh(w.id, at);
    const stored = await prisma.inTenant(w.id, (tx) => tx.reportWeek.findMany({ orderBy: { weekStart: 'asc' } }));

    for (const [week, row] of [previousStart, start].map((day, index) => [day, stored[index]] as const)) {
      const range = await reports.metricsFor(w.id, { from: week, to: addDays(week, 6) }, at);
      const { by_product: _byProduct, ...orders } = range.orders;
      expect({ ...range, orders }).toEqual(weekMetricsSchema.parse(row.data));
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
