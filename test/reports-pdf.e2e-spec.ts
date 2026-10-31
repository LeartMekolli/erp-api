import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import type { TenantPermission } from '../src/modules/identity/permissions';
import { ReportsService } from '../src/modules/reporting/reports.service';
import { addDays, weekOf } from '../src/modules/reporting/week-metrics';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

const WEEK_MS = 7 * 86_400_000;
const fixture: JobRegistry = { jobs: { ...JOBS, 'reports.export': { ...JOBS['reports.export'], backoffMs: 10 } }, scheduled: SCHEDULED_JOBS };

/** The dashboard's numbers for any dates, as a PDF (Reporting 2 plan, Task 5). */
describe('reporting: the dashboard as a PDF', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JOB_REGISTRY).useValue(fixture).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  /** This week Luna orders 10 pieces and Sol 12; last week Luna ordered 15. A reader may not see partners. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const reader = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      const role = await tx.role.create({ data: { name: 'reporter', isSystem: false } });
      const permissions: TenantPermission[] = ['report.export', 'report.read', 'payment.read'];
      await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: role.id, permission })) });
      await tx.userRole.create({ data: { userId: reader.id, roleId: role.id } });
    });

    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const speeds = (await staff.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] };
    await staff.patch(`/pricing/delivery-speeds/${speeds.data.find((speed) => speed.key === 'standard')!.id}`, { working_days: 10 }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '0' }] }).expect(200);

    const customer = async (name: string) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      await staff.put(`/customers/${id}/payment-terms`, { terms: 'pay_later' }).expect(200);
      return id;
    };
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
      const body = (
        await staff
          .post('/orders', {
            customer_id: customerId,
            lines: [{ quote_id: quote.id }],
            address: { name: 'Studio', line1: 'Main street 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
            shipping_method: 'courier',
          })
          .expect(201)
      ).body as { id: string; lines: { total: string }[] };
      return { id: body.id, lines: new Prisma.Decimal(body.lines[0].total) };
    };
    const luna = await customer('Luna Jewels');
    const sol = await customer('Sol Studio');
    const lunaNow = await order(luna, 10);
    const solNow = await order(sol, 12);
    const lunaLastWeek = await order(luna, 15);
    await prisma.inTenant(tenant.id, async (tx) => {
      const row = await tx.order.findUniqueOrThrow({ where: { id: lunaLastWeek.id } });
      await tx.order.update({ where: { id: row.id }, data: { placedAt: new Date(row.placedAt.getTime() - WEEK_MS) } });
    });
    const names = await prisma.inTenant(tenant.id, async (tx) => ({
      workspace: (await tx.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { name: true } })).name,
      product: (await tx.product.findUniqueOrThrow({ where: { id: cast.productId }, select: { name: true } })).name,
    }));

    return {
      id: tenant.id,
      staff,
      reader: as((await tokens.issueForUser(tenant.id, reader.id)).accessToken),
      names,
      productRevenue: lunaNow.lines.add(solNow.lines).add(lunaLastWeek.lines),
    };
  }

  /** Asks for the PDF, waits for it, and gives its bytes and its text. */
  const pdfOf = async (client: Client, params: object) => {
    const id = ((await client.post('/reports/exports', { kind: 'dashboard_pdf', params }).expect(202)).body as { id: string }).id;
    const done = await waitFor(async () => {
      const body = (await client.get(`/reports/exports/${id}`).expect(200)).body as { status: string; rows: number | null };
      if (body.status === 'failed') throw new Error(JSON.stringify(body));
      return body.status === 'ready' ? body : undefined;
    }, 15_000);
    expect(done.rows).toBeNull();
    const link = (await client.post(`/reports/exports/${id}/download`).expect(200)).body as { url: string };
    const bytes = Buffer.from(await (await fetch(link.url)).arrayBuffer());
    const { extractText } = await import('unpdf');
    return { bytes, text: (await extractText(new Uint8Array(bytes), { mergePages: true })).text };
  };

  it('makes the dashboard PDF for a range, with revenue per product', async () => {
    const w = await workspace();
    const { start, previousStart } = weekOf(new Date(), 'UTC');
    const to = addDays(start, 6);

    const { bytes, text } = await pdfOf(w.staff, { from: previousStart, to });

    expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(text).toContain(w.names.workspace);
    expect(text).toContain(`${previousStart} – ${to}`);
    for (const heading of ['Orders', 'Revenue per product', 'Production', 'Customers', 'Partners']) expect(text).toContain(heading);
    expect(text).toContain(w.names.product);
    expect(text).toContain(`${w.productRevenue.toFixed(2)} EUR`);
  });

  it('shows the same figures as the dashboard for the same week (Review Focus 5)', async () => {
    const w = await workspace();
    await app.get(ReportsService).refresh(w.id, new Date());
    const dashboard = (await w.staff.get('/reports/dashboard').expect(200)).body as {
      week: { start: string };
      current: { orders: { placed: number; revenue: string; average_value: string } };
    };

    const { text } = await pdfOf(w.staff, { from: dashboard.week.start, to: addDays(dashboard.week.start, 6) });

    expect(dashboard.current.orders.placed).toBe(2);
    expect(text).toContain(`${dashboard.current.orders.revenue} EUR`);
    expect(text).toContain(`${dashboard.current.orders.average_value} EUR`);
  });

  it('leaves the partner section out without partner.read', async () => {
    const w = await workspace();
    const { start } = weekOf(new Date(), 'UTC');

    const { text } = await pdfOf(w.reader, { from: start, to: addDays(start, 6) });

    expect(text).toContain('Revenue per product');
    expect(text).not.toContain('Partners');
  });

  it('refuses a range over 366 days, or ending before it starts, or without report.read', async () => {
    const w = await workspace();
    const today = new Date().toISOString().slice(0, 10);
    await w.staff.post('/reports/exports', { kind: 'dashboard_pdf', params: { from: addDays(today, -366), to: today } }).expect(400);
    await w.staff.post('/reports/exports', { kind: 'dashboard_pdf', params: { from: today, to: addDays(today, -1) } }).expect(400);
    await w.staff.post('/reports/exports', { kind: 'dashboard_pdf', params: {} }).expect(400);

    const noReports = await createTestUser(prisma, w.id, { roles: [] });
    await prisma.inTenant(w.id, async (tx) => {
      const role = await tx.role.create({ data: { name: 'exporter', isSystem: false } });
      await tx.rolePermission.create({ data: { roleId: role.id, permission: 'report.export' } });
      await tx.userRole.create({ data: { userId: noReports.id, roleId: role.id } });
    });
    const client = as((await tokens.issueForUser(w.id, noReports.id)).accessToken);
    await client.post('/reports/exports', { kind: 'dashboard_pdf', params: { from: today, to: today } }).expect(403);
  });
});
