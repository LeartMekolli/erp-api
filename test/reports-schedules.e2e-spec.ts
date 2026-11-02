import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import type { TenantPermission } from '../src/modules/identity/permissions';
import { exportDownloadSchema, exportResponseSchema } from '../src/modules/reporting/exports/export-response';
import { ScheduledExportsService } from '../src/modules/reporting/exports/scheduled-exports.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

const fixture: JobRegistry = { jobs: { ...JOBS, 'reports.export': { ...JOBS['reports.export'], backoffMs: 10 } }, scheduled: SCHEDULED_JOBS };
const ACCOUNTING = ['accounting_invoices', 'accounting_payments', 'accounting_payouts', 'accounting_refunds'];

interface Export {
  id: string;
  kind: string;
  status: string;
}

/** A CSV's lines as cells, without the BOM. None of this test's values hold a comma. */
function parse(bytes: Buffer): string[][] {
  return bytes
    .subarray(3)
    .toString('utf8')
    .split('\r\n')
    .filter((line) => line !== '')
    .map((line) => line.split(','));
}

/** `YYYY-MM` of the month before the one `date` (YYYY-MM-DD) is in, `back` months back. */
function monthBefore(date: string, back = 1): string {
  const [year, month] = date.split('-').map(Number);
  const index = year * 12 + (month - 1) - back;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/**
 * Orders 3a, Task 6: an Accountant role that only reads; the accountant's files and the top-customers
 * export made once a month for last month, on or after the workspace's 1st, and their recipients told
 * while they may still read them.
 */
describe('reports: scheduled exports', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let schedules: ScheduledExportsService;
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
    schedules = app.get(ScheduledExportsService);
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
   * The owner; an accountant with the system role; a clerk who may export and read reports but not money.
   * Luna Jewels has two orders last month, one claimed and remade, and one the month before; Sol Studio
   * one smaller order last month. The workspace is in UTC.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const accountant = await createTestUser(prisma, tenant.id, { roles: ['accountant'] });
    const clerk = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      const role = await tx.role.create({ data: { name: 'clerk', isSystem: false } });
      const permissions: TenantPermission[] = ['report.export', 'report.read'];
      await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: role.id, permission })) });
      await tx.userRole.create({ data: { userId: clerk.id, roleId: role.id } });
    });
    const client = async (userId: string) => as((await tokens.issueForUser(tenant.id, userId)).accessToken);
    const staff = await client(owner.id);

    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '0' }] }).expect(200);

    const today = new Date().toISOString().slice(0, 10);
    const lastMonth = monthBefore(today);
    const customer = async (name: string) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      await staff.put(`/customers/${id}/payment-terms`, { terms: 'pay_later' }).expect(200);
      return id;
    };
    /** An order of `quantity` pieces, moved to the 15th of `month` at noon; its customer pays later. */
    const order = async (customerId: string, quantity: number, month: string) => {
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
      const placed = (
        await staff
          .post('/orders', {
            customer_id: customerId,
            lines: [{ quote_id: quote.id }],
            address: { name: 'Studio', line1: 'Main street 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
            shipping_method: 'courier',
          })
          .expect(201)
      ).body as { id: string; total: string; tax: { amount: string }; lines: { id: string }[] };
      await prisma.inTenant(tenant.id, (tx) => tx.order.update({ where: { id: placed.id }, data: { placedAt: new Date(`${month}-15T12:00:00Z`) } }));
      return { id: placed.id, lineId: placed.lines[0].id, net: new Prisma.Decimal(placed.total).sub(placed.tax.amount) };
    };

    const luna = await customer('Luna Jewels');
    const sol = await customer('Sol Studio');
    const lunaOrders = [await order(luna, 6, lastMonth), await order(luna, 5, lastMonth)];
    const lunaBefore = await order(luna, 2, monthBefore(today, 2));
    const solOrder = await order(sol, 2, lastMonth);
    // Luna claimed a piece of its first order last month, and it was remade. Claims are opened on delivered
    // orders; the row is written directly, as the claims suites test opening them.
    const at = new Date(`${lastMonth}-20T12:00:00Z`);
    await prisma.inTenant(tenant.id, (tx) =>
      tx.claim.create({
        data: {
          orderId: lunaOrders[0].id,
          number: 1,
          reason: 'defect',
          description: 'Cracked shank.',
          openedByUserId: owner.id,
          openedByKind: 'staff',
          createdAt: at,
          lines: {
            create: [{ orderLineId: lunaOrders[0].lineId, pieces: 1, fault: 'workspace', outcome: 'remake', decidedByUserId: owner.id, decidedAt: at }],
          },
        },
      }),
    );

    return {
      id: tenant.id,
      staff,
      owner,
      accountantId: accountant.id,
      accountant: await client(accountant.id),
      clerkId: clerk.id,
      clerk: await client(clerk.id),
      luna,
      sol,
      lunaOrders,
      lunaBefore,
      solOrder,
      lastMonth,
    };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const schedule = (w: Workspace, value: object) => w.staff.put('/settings/reports.schedules', value).expect(200);
  const off = { enabled: false, recipientUserIds: [] };
  /** The workspace's scheduled exports, once none is pending. */
  const built = (w: Workspace, count: number) =>
    waitFor(async () => {
      const rows = await prisma.inTenant(w.id, (tx) => tx.reportExport.findMany({ where: { scheduleKey: { not: null } }, orderBy: { kind: 'asc' } }));
      return rows.length === count && rows.every((row) => row.status === 'ready') ? rows : undefined;
    }, 20_000);
  const told = (w: Workspace, userId: string) =>
    prisma.inTenant(w.id, (tx) => tx.notification.findMany({ where: { eventKey: 'export.scheduled_ready', subjectType: 'user', subjectId: userId } }));
  const download = async (client: Client, id: string) => {
    const link = await client.post(`/reports/exports/${id}/download`).expect(200);
    expectDocumented(exportDownloadSchema, link.body);
    return parse(Buffer.from(await (await fetch((link.body as { url: string }).url)).arrayBuffer()));
  };

  it("makes last month's accountant files once, on or after the 1st, and tells the accountant", async () => {
    const w = await workspace();
    await schedule(w, { accounting: { enabled: true, recipientUserIds: [w.accountantId] }, top_customers: off });

    const made = await schedules.runDue(w.id, new Date());
    expect([...made].sort()).toEqual(ACCOUNTING.map((kind) => `${kind}:${w.lastMonth}`));
    // Run again, nothing more is made.
    expect(await schedules.runDue(w.id, new Date())).toEqual([]);

    const rows = await built(w, 4);
    expect(rows.map((row) => [row.kind, row.requestedByUserId, row.params])).toEqual(ACCOUNTING.map((kind) => [kind, null, { month: w.lastMonth }]));

    // The accountant reads, lists and downloads them.
    const listed = await w.accountant.get('/reports/exports').expect(200);
    expectDocumented(pageSchema(exportResponseSchema), listed.body);
    expect((listed.body as { data: Export[] }).data.map((one) => one.kind).sort()).toEqual(ACCOUNTING);
    const invoices = rows.find((row) => row.kind === 'accounting_invoices')!;
    expectDocumented(exportResponseSchema, (await w.accountant.get(`/reports/exports/${invoices.id}`).expect(200)).body);
    expect((await download(w.accountant, invoices.id))[0].length).toBeGreaterThan(0);

    // The accountant exports, but changes nothing.
    await w.accountant.post('/reports/exports', { kind: 'accounting_payments', params: { month: w.lastMonth } }).expect(202);
    await w.accountant.post(`/orders/${w.solOrder.id}/cancel`, { reason: 'Not allowed' }).expect(403);

    // Told once, with the month and the four files.
    const notices = await waitFor(async () => {
      const found = await told(w, w.accountantId);
      return found.length > 0 ? found : undefined;
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].payload).toMatchObject({ month: w.lastMonth, exports: expect.stringContaining(invoices.id) });
  });

  it('makes the top-customers export ranked by revenue, with claims', async () => {
    const w = await workspace();
    await schedule(w, { accounting: off, top_customers: { enabled: true, recipientUserIds: [w.owner.id] } });

    expect(await schedules.runDue(w.id, new Date())).toEqual([`top_customers:${w.lastMonth}`]);
    const [row] = await built(w, 1);
    expect(row).toMatchObject({ kind: 'top_customers', requestedByUserId: null });

    const [header, ...lines] = await download(w.staff, row.id);
    expect(header).toEqual([
      'Customer ID',
      'Customer',
      'Customer group',
      'Band',
      'Orders',
      'Revenue (net)',
      'Orders before',
      'Revenue before (net)',
      'Claims',
      'Remakes',
      'Currency',
    ]);
    const lunaRevenue = w.lunaOrders[0].net.add(w.lunaOrders[1].net);
    expect(lines).toEqual([
      [w.luna, 'Luna Jewels', '', 'Standard', '2', lunaRevenue.toFixed(2), '1', w.lunaBefore.net.toFixed(2), '1', '1', 'EUR'],
      [w.sol, 'Sol Studio', '', 'Standard', '1', w.solOrder.net.toFixed(2), '0', '0.00', '0', '0', 'EUR'],
    ]);
    // Staff may ask for it too, for any range.
    await w.staff.post('/reports/exports', { kind: 'top_customers', params: { from: `${w.lastMonth}-01`, to: `${w.lastMonth}-28` } }).expect(202);
    // Only with payment.read.
    await w.clerk.post('/reports/exports', { kind: 'top_customers', params: { from: `${w.lastMonth}-01`, to: `${w.lastMonth}-28` } }).expect(403);
  });

  it('tells only recipients still allowed, and makes it once with no recipients (Review Focus 5)', async () => {
    const w = await workspace();
    // No recipients: made once all the same, and nobody told.
    await schedule(w, { accounting: { enabled: true, recipientUserIds: [] }, top_customers: off });
    expect(await schedules.runDue(w.id, new Date())).toHaveLength(4);
    const rows = await built(w, 4);
    expect(await prisma.inTenant(w.id, (tx) => tx.notification.count({ where: { eventKey: 'export.scheduled_ready' } }))).toBe(0);

    // A recipient without payment.read is never told, and can't read or download the files.
    const other = await workspace();
    await schedule(other, { accounting: { enabled: true, recipientUserIds: [other.clerkId, other.accountantId] }, top_customers: off });
    await schedules.runDue(other.id, new Date());
    const files = await built(other, 4);
    await waitFor(async () => ((await told(other, other.accountantId)).length > 0 ? true : undefined));
    expect(await told(other, other.clerkId)).toEqual([]);
    await other.clerk.get(`/reports/exports/${files[0].id}`).expect(404);
    await other.clerk.post(`/reports/exports/${files[0].id}/download`).expect(404);
    expect(((await other.clerk.get('/reports/exports').expect(200)).body as { data: Export[] }).data).toEqual([]);

    // Neither workspace reads the other's.
    await other.accountant.get(`/reports/exports/${rows[0].id}`).expect(404);
  });
});
