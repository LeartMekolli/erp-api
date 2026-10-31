import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { JobsService } from '../src/jobs/jobs.service';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import type { TenantPermission } from '../src/modules/identity/permissions';
import { localDate } from '../src/modules/orders/dates';
import type { CsvCell } from '../src/modules/reporting/exports/csv';
import type { CsvBuilder } from '../src/modules/reporting/exports/export-kinds';
import { exportDownloadSchema, exportResponseSchema, exportStartedSchema } from '../src/modules/reporting/exports/export-response';
import { ExportsService } from '../src/modules/reporting/exports/exports.service';
import { addDays } from '../src/modules/reporting/week-metrics';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

const DAY_MS = 86_400_000;
const fixture: JobRegistry = { jobs: { ...JOBS, 'reports.export': { ...JOBS['reports.export'], backoffMs: 10 } }, scheduled: SCHEDULED_JOBS };

interface Export {
  id: string;
  kind: string;
  status: 'pending' | 'ready' | 'failed' | 'expired';
  rows: number | null;
  error: string | null;
  expires_at: string | null;
  downloaded_at: string | null;
}

/** A CSV's lines as cells, without the BOM. None of this test's values hold a comma. */
function parse(bytes: Buffer): string[][] {
  expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  return bytes
    .subarray(3)
    .toString('utf8')
    .split('\r\n')
    .filter((line) => line !== '')
    .map((line) => line.split(','));
}

/** Staff export data as CSV, built in the background (Reporting 2 plan, Task 1). */
describe('reporting: exports', () => {
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

  /**
   * Luna has two orders this week and one cancelled; Sol one placed 400 days ago. Staff: the owner, a
   * second owner, a clerk who may export customers but not read money, a member (no `report.export`) and
   * an exporter who may export but not read customers.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const secondOwner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const role = async (name: string, permissions: TenantPermission[]) => {
      const user = await createTestUser(prisma, tenant.id, { roles: [] });
      const roleId = await prisma.inTenant(tenant.id, async (tx) => {
        const created = await tx.role.create({ data: { name, isSystem: false } });
        await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: created.id, permission })) });
        await tx.userRole.create({ data: { userId: user.id, roleId: created.id } });
        return created.id;
      });
      return { id: user.id, roleId };
    };
    const clerk = await role('clerk', ['report.export', 'customer.read']);
    const exporter = await role('exporter', ['report.export']);
    const orderClerk = await role('order clerk', ['report.export', 'order.read']);
    const client = async (userId: string) => as((await tokens.issueForUser(tenant.id, userId)).accessToken);
    const staff = await client(owner.id);

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
    /** An order of `lines` lines, of 2 pieces then 3, 4…; its customer pays later, so it starts at once. */
    const order = async (customerId: string, lines = 1) => {
      const quotes: { id: string }[] = [];
      for (let line = 0; line < lines; line += 1) {
        const quote = ((
          await staff
            .post('/pricing/quotes', {
              product_id: cast.productId,
              options: { material: 'silver_925', finish: 'polished' },
              size: { scale: '1.5' },
              quantity: 2 + line,
              file_version_id: cast.versionId,
              customer_id: customerId,
            })
            .expect(201)
        ).body as { quote: { id: string } }).quote;
        quotes.push(quote);
      }
      const placed = (
        await staff
          .post('/orders', {
            customer_id: customerId,
            lines: quotes.map((quote) => ({ quote_id: quote.id })),
            address: { name: 'Studio', line1: 'Main street 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
            shipping_method: 'courier',
          })
          .expect(201)
      ).body as { id: string; total: string; tax: { amount: string } };
      return { id: placed.id, net: new Prisma.Decimal(placed.total).sub(placed.tax.amount) };
    };

    const luna = await customer('Luna Jewels');
    const sol = await customer('Sol Studio');
    const first = await order(luna);
    const second = await order(luna);
    const cancelled = await order(luna);
    await staff.post(`/orders/${cancelled.id}/cancel`, { reason: 'Customer phoned' }).expect(200);
    const old = await order(sol);
    await prisma.inTenant(tenant.id, async (tx) => {
      const row = await tx.order.findUniqueOrThrow({ where: { id: old.id } });
      await tx.order.update({ where: { id: row.id }, data: { placedAt: new Date(row.placedAt.getTime() - 400 * DAY_MS) } });
    });

    const today = localDate(new Date(), 'UTC');
    const number = async (orderId: string) =>
      (await prisma.inTenant(tenant.id, (tx) => tx.order.findUniqueOrThrow({ where: { id: orderId } }))).number;
    return {
      tenantId: tenant.id,
      staff,
      owner,
      clerk,
      luna,
      sol,
      cast,
      order,
      number,
      lunaOrders: { first: await number(first.id), second: await number(second.id), cancelled: await number(cancelled.id) },
      lunaRevenue: first.net.add(second.net),
      range: { from: addDays(today, -7), to: today },
      second: await client(secondOwner.id),
      member: await client(member.id),
      clerkClient: await client(clerk.id),
      exporter: await client(exporter.id),
      orderClerk: await client(orderClerk.id),
    };
  }

  const ask = async (client: Client, body: object) => {
    const started = await client.post('/reports/exports', body).expect(202);
    expectDocumented(exportStartedSchema, started.body);
    return (started.body as { id: string }).id;
  };
  const finished = (client: Client, id: string) =>
    waitFor(async () => {
      const body = (await client.get(`/reports/exports/${id}`).expect(200)).body as Export;
      return body.status === 'pending' ? undefined : body;
    }, 15_000);
  const download = async (client: Client, id: string) => {
    const link = await client.post(`/reports/exports/${id}/download`).expect(200);
    expectDocumented(exportDownloadSchema, link.body);
    return parse(Buffer.from(await (await fetch((link.body as { url: string }).url)).arrayBuffer()));
  };

  it('exports the customers in the background and tells the asker', async () => {
    const w = await workspace();
    const id = await ask(w.staff, { kind: 'customers', params: w.range });

    const done = await finished(w.staff, id);
    expectDocumented(exportResponseSchema, done);
    expect(done).toMatchObject({ kind: 'customers', status: 'ready', rows: 2, error: null, downloaded_at: null });
    expect(new Date(done.expires_at!).getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);

    const [header, ...rows] = await download(w.staff, id);
    expect(header).toEqual(['Customer ID', 'Name', 'Status', 'Plan', 'Payment terms', 'Created on', 'Orders', 'Revenue (net)', 'Currency']);
    expect(rows).toEqual([
      [w.luna, 'Luna Jewels', 'active', 'Starter', 'pay_later', w.range.to, '2', w.lunaRevenue.toFixed(2), 'EUR'],
      // Sol's order is outside the range.
      [w.sol, 'Sol Studio', 'active', 'Starter', 'pay_later', w.range.to, '0', '0.00', 'EUR'],
    ]);

    const feed = await waitFor(async () => {
      const body = (await w.staff.get('/notifications').expect(200)).body as { data: { event_key: string; subject: { id: string } }[] };
      return body.data.find((entry) => entry.event_key === 'report.export_ready');
    });
    expect(feed.subject.id).toBe(w.owner.id);

    const list = await w.staff.get('/reports/exports').expect(200);
    expectDocumented(pageSchema(exportResponseSchema), list.body);
    expect((list.body as { data: Export[] }).data.map((one) => one.id)).toEqual([id]);
  });

  it('leaves the money columns out without payment.read', async () => {
    const w = await workspace();
    const id = await ask(w.clerkClient, { kind: 'customers', params: {} });
    await finished(w.clerkClient, id);

    const [header, luna] = await download(w.clerkClient, id);
    expect(header).toEqual(['Customer ID', 'Name', 'Status', 'Plan', 'Payment terms', 'Created on', 'Orders']);
    // All time without a range: the cancelled order still doesn't count.
    expect(luna.at(-1)).toBe('2');
  });

  it("refuses without report.export, and without the kind's own permission", async () => {
    const w = await workspace();
    await w.member.post('/reports/exports', { kind: 'customers', params: {} }).expect(403);
    await w.exporter.post('/reports/exports', { kind: 'customers', params: {} }).expect(403);
    await w.staff.post('/reports/exports', { kind: 'customers', params: { from: w.range.to, to: w.range.from } }).expect(400);
    await w.staff.post('/reports/exports', { kind: 'customers', params: { from: w.range.from } }).expect(400);
    expect(await prisma.inTenant(w.tenantId, (tx) => tx.reportExport.count())).toBe(0);
  });

  it('builds from the permissions held when asked (Review Focus 2)', async () => {
    const w = await workspace();
    // Nothing is queued: the test runs the job itself, after the role has changed.
    const enqueue = jest.spyOn(app.get(JobsService), 'enqueue').mockResolvedValue(undefined);
    try {
      const withMoney = await ask(w.staff, { kind: 'customers', params: {} });
      const withoutMoney = await ask(w.clerkClient, { kind: 'customers', params: {} });
      await prisma.inTenant(w.tenantId, (tx) =>
        tx.rolePermission.create({ data: { roleId: w.clerk.roleId, permission: 'payment.read' } }),
      );
      const exports = worker.get(ExportsService);
      await exports.run(w.tenantId, withMoney);
      await exports.run(w.tenantId, withoutMoney);

      expect((await download(w.staff, withMoney))[0]).toContain('Revenue (net)');
      expect((await download(w.clerkClient, withoutMoney))[0]).not.toContain('Revenue (net)');
    } finally {
      enqueue.mockRestore();
    }
  });

  it('gives nobody else the export, its link or its file (Review Focus 3)', async () => {
    const w = await workspace();
    const id = await ask(w.staff, { kind: 'customers', params: {} });
    await finished(w.staff, id);

    await w.second.get(`/reports/exports/${id}`).expect(404);
    await w.second.post(`/reports/exports/${id}/download`).expect(404);
    expect((await w.second.get('/reports/exports').expect(200)).body).toMatchObject({ data: [] });
    // Not through the files routes either, even for staff who read every file.
    await w.second.get(`/files/${id}`).expect(404);
    await w.staff.get(`/files/${id}`).expect(404);
    expect((await w.staff.get(`/reports/exports/${id}`).expect(200)).body).toMatchObject({ downloaded_at: null });

    await download(w.staff, id);
    const first = ((await w.staff.get(`/reports/exports/${id}`).expect(200)).body as Export).downloaded_at;
    expect(first).not.toBeNull();
    await download(w.staff, id);
    expect(((await w.staff.get(`/reports/exports/${id}`).expect(200)).body as Export).downloaded_at).toBe(first);
  });

  it('fails plainly past the row limit, and tells the asker', async () => {
    const w = await workspace();
    const exports = worker.get(ExportsService);
    exports.rowLimit = 1;
    try {
      const id = await ask(w.staff, { kind: 'customers', params: {} });
      const failed = await finished(w.staff, id);
      expect(failed).toMatchObject({ status: 'failed', rows: null });
      expect(failed.error).toContain('narrow the period');
      await w.staff.post(`/reports/exports/${id}/download`).expect(409);
      await waitFor(async () => {
        const body = (await w.staff.get('/notifications').expect(200)).body as { data: { event_key: string }[] };
        return body.data.find((entry) => entry.event_key === 'report.export_failed');
      });
    } finally {
      exports.rowLimit = 100_000;
    }
  });

  it('removes the file after 30 days and keeps the log', async () => {
    const w = await workspace();
    const id = await ask(w.staff, { kind: 'customers', params: {} });
    const done = await finished(w.staff, id);
    const exports = app.get(ExportsService);

    expect(await exports.expireDueIn(w.tenantId, new Date(new Date(done.expires_at!).getTime() - 1))).toBe(0);
    expect(await exports.expireDueIn(w.tenantId, new Date(new Date(done.expires_at!).getTime() + 1))).toBe(1);

    expect((await w.staff.get(`/reports/exports/${id}`).expect(200)).body).toMatchObject({ status: 'expired', rows: 2 });
    await w.staff.post(`/reports/exports/${id}/download`).expect(409);
    expect(await prisma.inTenant(w.tenantId, (tx) => tx.file.findUniqueOrThrow({ where: { id } }))).toMatchObject({ status: 'removed' });
  });

  it('reads the next page after the last row, so a customer added meanwhile neither repeats nor skips a row (review fix)', async () => {
    const w = await workspace();
    const builder = app.get(ExportsService).builderOf('customers') as CsvBuilder;
    const pages = builder
      .pages({ tenantId: w.tenantId, params: {}, may: new Set<TenantPermission>(), timeZone: 'UTC', currency: 'EUR', pageSize: 1 })
      [Symbol.asyncIterator]();

    const first = await pages.next();
    // Sorts before every row read so far: counting rows from the top would read Luna again.
    await w.staff.post('/customers', { name: 'Aaron Atelier' }).expect(201);
    const rest: Record<string, CsvCell>[] = [];
    for (let page = await pages.next(); !page.done; page = await pages.next()) rest.push(...page.value);

    expect((first.value as Record<string, CsvCell>[]).map((row) => row.name)).toEqual(['Luna Jewels']);
    expect(rest.map((row) => row.name)).toEqual(['Sol Studio']);
  });

  describe('orders and partners (Task 2)', () => {
    const ORDER_COLUMNS = ['Order', 'Placed on', 'Customer', 'State', 'Promised on', 'Shipped on', 'Delivered on', 'Line', 'Product', 'Quantity'];
    const MONEY_COLUMNS = ['Unit price', 'Line total', 'Order lines total', 'Shipping', 'Tax', 'Order total', 'Currency'];
    /** Order number, customer, state, line and quantity of each row. */
    const brief = (rows: string[][]) => rows.map((row) => [row[0], row[2], row[3], row[7], row[9]]);

    it('exports orders one row per line, filtered by dates, customer and state', async () => {
      const w = await workspace();
      const solOrder = await w.order(w.sol, 2);
      const sol = String(await w.number(solOrder.id));
      const { first, second, cancelled } = w.lunaOrders;
      const exportOf = async (params: object) => {
        const id = await ask(w.staff, { kind: 'orders', params: { ...w.range, ...params } });
        expect(await finished(w.staff, id)).toMatchObject({ status: 'ready' });
        return download(w.staff, id);
      };

      const [header, ...all] = await exportOf({});
      expect(header).toEqual([...ORDER_COLUMNS, ...MONEY_COLUMNS, 'Partner']);
      // Sol's order of 400 days ago is outside the dates; its two-line order repeats the order on each line.
      expect(brief(all)).toEqual([
        [String(first), 'Luna Jewels', 'in_production', '1', '2'],
        [String(second), 'Luna Jewels', 'in_production', '1', '2'],
        [String(cancelled), 'Luna Jewels', 'cancelled', '1', '2'],
        [sol, 'Sol Studio', 'in_production', '1', '2'],
        [sol, 'Sol Studio', 'in_production', '2', '3'],
      ]);
      const [solFirst, solSecond] = all.slice(3);
      expect(solFirst.slice(12, 17)).toEqual(solSecond.slice(12, 17));
      expect(solFirst[16]).toBe('EUR');

      expect(brief((await exportOf({ customer_id: w.sol })).slice(1))).toEqual(brief(all.slice(3)));
      expect(brief((await exportOf({ states: ['cancelled'] })).slice(1))).toEqual([[String(cancelled), 'Luna Jewels', 'cancelled', '1', '2']]);
      expect((await exportOf({ states: ['in_production', 'cancelled'] })).slice(1)).toHaveLength(5);
    });

    it('leaves money and partner columns out without their permissions', async () => {
      const w = await workspace();
      const id = await ask(w.orderClerk, { kind: 'orders', params: w.range });
      await finished(w.orderClerk, id);

      const [header, ...rows] = await download(w.orderClerk, id);
      expect(header).toEqual(ORDER_COLUMNS);
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.length === ORDER_COLUMNS.length)).toBe(true);
    });

    it('refuses an order range over 366 days, or ending before it starts', async () => {
      const w = await workspace();
      const year = { from: addDays(w.range.to, -365), to: w.range.to };
      await w.staff.post('/reports/exports', { kind: 'orders', params: year }).expect(202);
      await w.staff.post('/reports/exports', { kind: 'orders', params: { ...year, from: addDays(year.from, -1) } }).expect(400);
      await w.staff.post('/reports/exports', { kind: 'orders', params: { from: w.range.to, to: w.range.from } }).expect(400);
      await w.staff.post('/reports/exports', { kind: 'orders', params: {} }).expect(400);
      await w.clerkClient.post('/reports/exports', { kind: 'orders', params: w.range }).expect(403);
    });

    it('exports partners with their capabilities, load and on-time rate, and by status', async () => {
      const w = await workspace();
      const partner = async (name: string) =>
        ((await w.staff.post('/partners', { name, display_name: name.split(' ')[0] }).expect(201)).body as { id: string }).id;
      const castco = await partner('CastCo Ltd');
      const layerline = await partner('Layerline Ltd');
      await w.staff
        .put(`/partners/${castco}/capabilities`, {
          capabilities: [w.cast.steps.polishing, w.cast.steps.casting].map((step_type_id) => ({ step_type_id, capacity: 100, capacity_period: 'week' })),
        })
        .expect(200);
      await prisma.inTenant(w.tenantId, (tx) => tx.partner.update({ where: { id: layerline }, data: { status: 'suspended' } }));

      const exportOf = async (params: object) => {
        const id = await ask(w.staff, { kind: 'partners', params });
        expect(await finished(w.staff, id)).toMatchObject({ status: 'ready' });
        return download(w.staff, id);
      };
      const [header, ...rows] = await exportOf({});
      expect(header).toEqual([
        'Partner ID',
        'Name',
        'Display name',
        'Status',
        'Capabilities',
        'Max open jobs',
        'Open jobs',
        'Load %',
        'On-time rate (90 days)',
        'Agreement signed on',
      ]);
      expect(rows).toEqual([
        [castco, 'CastCo Ltd', 'CastCo', 'setting_up', 'casting; polishing', '', '0', '0', '', ''],
        [layerline, 'Layerline Ltd', 'Layerline', 'suspended', '', '', '0', '0', '', ''],
      ]);

      expect((await exportOf({ status: 'suspended' })).slice(1).map((row) => row[0])).toEqual([layerline]);
      await w.clerkClient.post('/reports/exports', { kind: 'partners', params: {} }).expect(403);
    });
  });
});
