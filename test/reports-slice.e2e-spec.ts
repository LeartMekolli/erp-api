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
import { ExportsService } from '../src/modules/reporting/exports/exports.service';
import { addDays } from '../src/modules/reporting/week-metrics';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

const fixture: JobRegistry = { jobs: { ...JOBS, 'reports.export': { ...JOBS['reports.export'], backoffMs: 10 } }, scheduled: SCHEDULED_JOBS };

/**
 * Reporting 2 end to end (spec, "Done when" 1–6), in one workspace: the accountant's month, a quarter's
 * orders, the dashboard as a PDF, who gets which file, the formula guard and the permission.
 */
describe('reporting: exports, end to end', () => {
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

  const ask = async (client: Client, body: object) => ((await client.post('/reports/exports', body).expect(202)).body as { id: string }).id;
  const ready = (client: Client, id: string) =>
    waitFor(async () => {
      const body = (await client.get(`/reports/exports/${id}`).expect(200)).body as { status: string; expires_at: string | null };
      if (body.status === 'failed') throw new Error(JSON.stringify(body));
      return body.status === 'ready' ? body : undefined;
    }, 15_000);
  const bytesOf = async (client: Client, id: string) => {
    const link = (await client.post(`/reports/exports/${id}/download`).expect(200)).body as { url: string };
    return Buffer.from(await (await fetch(link.url)).arrayBuffer());
  };
  const csvOf = async (client: Client, id: string) =>
    (await bytesOf(client, id))
      .subarray(3)
      .toString('utf8')
      .split('\r\n')
      .filter((line) => line !== '')
      .map((line) => line.split(','));

  it('gets the data out as CSV and PDF files, for whoever may see it, and keeps the log', async () => {
    // --- The workspace: an owner, an order clerk (no money, no partners) and a member (no report.export).
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const clerkUser = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      const role = await tx.role.create({ data: { name: 'order clerk', isSystem: false } });
      const permissions: TenantPermission[] = ['report.export', 'report.read', 'order.read', 'customer.read'];
      await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: role.id, permission })) });
      await tx.userRole.create({ data: { userId: clerkUser.id, roleId: role.id } });
    });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const clerk = as((await tokens.issueForUser(tenant.id, clerkUser.id)).accessToken);
    const memberClient = as((await tokens.issueForUser(tenant.id, member.id)).accessToken);

    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const speeds = (await staff.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] };
    await staff.patch(`/pricing/delivery-speeds/${speeds.data.find((speed) => speed.key === 'standard')!.id}`, { working_days: 10 }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '0' }] }).expect(200);

    // Luna orders twice, with two lines the second time; a customer whose name a spreadsheet would run.
    const customer = async (name: string) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      await staff.put(`/customers/${id}/payment-terms`, { terms: 'pay_later' }).expect(200);
      return id;
    };
    const luna = await customer('Luna Jewels');
    await customer('=HYPERLINK("https://evil.example.test")');
    const order = async (lines: number[]) => {
      const quotes: { id: string }[] = [];
      for (const quantity of lines) {
        const quote = ((
          await staff
            .post('/pricing/quotes', {
              product_id: cast.productId,
              options: { material: 'silver_925', finish: 'polished' },
              size: { scale: '1.5' },
              quantity,
              file_version_id: cast.versionId,
              customer_id: luna,
            })
            .expect(201)
        ).body as { quote: { id: string } }).quote;
        quotes.push(quote);
      }
      return (
        await staff
          .post('/orders', {
            customer_id: luna,
            lines: quotes.map((quote) => ({ quote_id: quote.id })),
            address: { name: 'Studio', line1: 'Main street 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
            shipping_method: 'courier',
          })
          .expect(201)
      ).body as { id: string; number: number };
    };
    const first = await order([2]);
    await order([3, 4]);
    const today = new Date().toISOString().slice(0, 10);
    const quarter = { from: addDays(today, -89), to: today };
    const month = today.slice(0, 7);
    await prisma.inTenant(tenant.id, (tx) =>
      tx.invoice.create({
        data: {
          orderId: first.id,
          providerInvoiceId: 'in_slice',
          url: 'https://invoices.example.test/in_slice',
          linesAmount: new Prisma.Decimal('100.00'),
          shipping: new Prisma.Decimal('9.90'),
          tax: new Prisma.Decimal('0.00'),
          total: new Prisma.Decimal('109.90'),
          currency: 'EUR',
          dueOn: new Date(),
          status: 'open',
        },
      }),
    );

    // --- Done when 1: the owner gets the month's invoices; the clerk, without payment.read, is refused.
    const invoices = await ask(staff, { kind: 'accounting_invoices', params: { month } });
    await ready(staff, invoices);
    const [invoiceHeader, ...invoiceRows] = await csvOf(staff, invoices);
    expect(invoiceHeader[0]).toBe('Invoice ID');
    expect(invoiceRows).toHaveLength(1);
    expect(invoiceRows[0][10]).toBe('109.90');
    await clerk.post('/reports/exports', { kind: 'accounting_invoices', params: { month } }).expect(403);

    // --- Done when 2: the clerk exports the quarter's orders, one row per line, without money columns.
    const orders = await ask(clerk, { kind: 'orders', params: quarter });
    await ready(clerk, orders);
    const [orderHeader, ...orderRows] = await csvOf(clerk, orders);
    expect(orderRows).toHaveLength(3);
    expect(orderHeader).not.toContain('Order total');
    expect(orderHeader).not.toContain('Partner');

    // --- Done when 3: the dashboard PDF for the quarter; the clerk's has no partner section.
    const { extractText } = await import('unpdf');
    const pdfText = async (client: Client) => {
      const id = await ask(client, { kind: 'dashboard_pdf', params: quarter });
      await ready(client, id);
      return (await extractText(new Uint8Array(await bytesOf(client, id)), { mergePages: true })).text;
    };
    const ownerPdf = await pdfText(staff);
    for (const heading of ['Orders', 'Revenue per product', 'Production', 'Customers', 'Partners']) expect(ownerPdf).toContain(heading);
    const clerkPdf = await pdfText(clerk);
    expect(clerkPdf).not.toContain('Partners');
    expect(clerkPdf).not.toContain('Revenue per product');

    // --- Done when 4: only the asker downloads; the log shows who downloaded; after 30 days the file goes and the log stays.
    await clerk.get(`/reports/exports/${invoices}`).expect(404);
    await clerk.post(`/reports/exports/${invoices}/download`).expect(404);
    const log = await prisma.inTenant(tenant.id, (tx) => tx.reportExport.findUniqueOrThrow({ where: { id: invoices } }));
    expect(log).toMatchObject({ requestedByUserId: owner.id, kind: 'accounting_invoices', status: 'ready', rows: 1 });
    expect(log.downloadedAt).toBeInstanceOf(Date);
    await app.get(ExportsService).expireDueIn(tenant.id, new Date(log.expiresAt!.getTime() + 1));
    expect((await staff.get(`/reports/exports/${invoices}`).expect(200)).body).toMatchObject({ status: 'expired', rows: 1 });
    await staff.post(`/reports/exports/${invoices}/download`).expect(409);

    // --- Done when 5: the customer whose name starts with `=` is written as text.
    const customers = await ask(staff, { kind: 'customers', params: {} });
    await ready(staff, customers);
    const names = (await csvOf(staff, customers)).slice(1).map((row) => row[1]);
    expect(names).toContain(`"'=HYPERLINK(""https://evil.example.test"")"`);

    // --- Done when 6: without report.export, every kind is refused.
    for (const body of [
      { kind: 'customers', params: {} },
      { kind: 'orders', params: quarter },
      { kind: 'partners', params: {} },
      { kind: 'accounting_payments', params: { month } },
      { kind: 'dashboard_pdf', params: quarter },
    ]) {
      await memberClient.post('/reports/exports', body).expect(403);
    }
  }, 120_000);
});
