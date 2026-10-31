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
import { feeJournal, receivedJournal } from '../src/modules/payments/ledger';
import type { JournalDraft } from '../src/modules/payments/ledger';
import { LedgerService } from '../src/modules/payments/ledger.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

const fixture: JobRegistry = { jobs: { ...JOBS, 'reports.export': { ...JOBS['reports.export'], backoffMs: 10 } }, scheduled: SCHEDULED_JOBS };
const d = (value: string) => new Prisma.Decimal(value);

/** A CSV's lines as cells, without the BOM. None of this test's values hold a comma. */
function parse(bytes: Buffer): string[][] {
  return bytes
    .subarray(3)
    .toString('utf8')
    .split('\r\n')
    .filter((line) => line !== '')
    .map((line) => line.split(','));
}

/**
 * The accountant's month (Reporting 2 plan, Task 3): invoices, payments with their fees, refunds and
 * payouts of one calendar month, each record once, from its own amounts.
 */
describe('reporting: the accounting export', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let ledger: LedgerService;
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

  // This month in UTC (the test workspace's time zone), and an instant in the month before.
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 12 * 3_600_000);

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JOB_REGISTRY).useValue(fixture).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    ledger = app.get(LedgerService);
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
   * This month: two invoices (one paid); a provider payment of 119.00 with a 3.75 fee; a payment of 50.00
   * by hand; a provider payment of 30.00, reversed; a refund of 20.00 that succeeded and one of 10.00 that
   * failed; a payout of 80.00 paid and one of 40.00 failed. Last month: one of each, which never shows.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const reader = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      const role = await tx.role.create({ data: { name: 'exporter', isSystem: false } });
      const permissions: TenantPermission[] = ['report.export', 'order.read', 'customer.read'];
      await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: role.id, permission })) });
      await tx.userRole.create({ data: { userId: reader.id, roleId: role.id } });
    });

    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const speeds = (await staff.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] };
    await staff.patch(`/pricing/delivery-speeds/${speeds.data.find((speed) => speed.key === 'standard')!.id}`, { working_days: 10 }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '0' }] }).expect(200);

    const customer = async (name: string) => ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
    const order = async (customerId: string) => {
      const quote = ((
        await staff
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 2,
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
      ).body as { id: string; number: number };
      return placed;
    };
    const luna = await customer('Luna Jewels');
    const sol = await customer('Sol Studio');
    const [lunaOrder, solOrder, oldOrder] = [await order(luna), await order(sol), await order(luna)];
    const castco = ((await staff.post('/partners', { name: 'CastCo Ltd', display_name: 'CastCo' }).expect(201)).body as { id: string }).id;

    const ids = await prisma.inTenant(tenant.id, async (tx) => {
      const invoice = (orderId: string, status: 'open' | 'paid', createdAt: Date, providerId: string) =>
        tx.invoice.create({
          data: {
            orderId,
            providerInvoiceId: providerId,
            url: `https://invoices.example.test/${providerId}`,
            linesAmount: d('100.00'),
            shipping: d('9.90'),
            tax: d('19.00'),
            total: d('128.90'),
            currency: 'EUR',
            dueOn: new Date(createdAt.getTime() + 30 * 86_400_000),
            status,
            paidAt: status === 'paid' ? createdAt : null,
            createdAt,
          },
        });
      const paidInvoice = await invoice(lunaOrder.id, 'paid', now, 'in_luna');
      const openInvoice = await invoice(solOrder.id, 'open', now, 'in_sol');
      await invoice(oldOrder.id, 'paid', lastMonth, 'in_old');

      const post = (journal: JournalDraft, orderId: string, customerId: string, occurredAt: Date, providerObjectId?: string) =>
        ledger.post(tx, { ...journal, occurredAt, currency: 'EUR', orderId, customerId, providerObjectId });
      const provider = await post(receivedJournal(luna, d('119.00'), 'stripe_balance'), lunaOrder.id, luna, now, 'cs_luna');
      await post(feeJournal(d('3.75')), lunaOrder.id, luna, now, 'cs_luna');
      const byHand = await post(receivedJournal(sol, d('50.00'), 'outside_stripe'), solOrder.id, sol, now);
      const reversed = await post(receivedJournal(sol, d('30.00'), 'stripe_balance'), solOrder.id, sol, now, 'cs_sol');
      const reversal = await ledger.reverse(tx, reversed.journalId, 'Paid twice by mistake');
      await post(receivedJournal(luna, d('500.00'), 'stripe_balance'), oldOrder.id, luna, lastMonth, 'cs_old');

      const refund = (orderId: string, amount: string, status: 'succeeded' | 'failed', createdAt: Date) =>
        tx.refund.create({ data: { orderId, amount: d(amount), reason: 'Scratched', kind: 'outside', status, createdByUserId: owner.id, createdAt } });
      const refunded = await refund(lunaOrder.id, '20.00', 'succeeded', now);
      const refundFailed = await refund(solOrder.id, '10.00', 'failed', now);
      await refund(oldOrder.id, '5.00', 'succeeded', lastMonth);

      const payout = (amount: string, status: 'paid' | 'failed', createdAt: Date, transfer: string | null) =>
        tx.payout.create({
          data: {
            partnerId: castco,
            amount: d(amount),
            currency: 'EUR',
            status,
            providerTransferId: transfer,
            failure: status === 'failed' ? 'Account closed' : null,
            createdByUserId: owner.id,
            createdAt,
            settledAt: status === 'paid' ? createdAt : null,
          },
        });
      const paid = await payout('80.00', 'paid', now, 'tr_paid');
      const payoutFailed = await payout('40.00', 'failed', now, null);
      await payout('70.00', 'paid', lastMonth, 'tr_old');

      return {
        paidInvoice: paidInvoice.id,
        openInvoice: openInvoice.id,
        provider: provider.journalId,
        byHand: byHand.journalId,
        reversed: reversed.journalId,
        reversal: reversal.journalId,
        refunded: refunded.id,
        refundFailed: refundFailed.id,
        paid: paid.id,
        payoutFailed: payoutFailed.id,
      };
    });

    return { tenantId: tenant.id, staff, reader: as((await tokens.issueForUser(tenant.id, reader.id)).accessToken), lunaOrder, solOrder, ids };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const exportOf = async (client: Client, kind: string, params: object = { month }) => {
    const id = ((await client.post('/reports/exports', { kind, params }).expect(202)).body as { id: string }).id;
    await waitFor(async () => {
      const body = (await client.get(`/reports/exports/${id}`).expect(200)).body as { status: string };
      if (body.status === 'failed') throw new Error(JSON.stringify(body));
      return body.status === 'ready' ? true : undefined;
    }, 15_000);
    const link = (await client.post(`/reports/exports/${id}/download`).expect(200)).body as { url: string };
    return parse(Buffer.from(await (await fetch(link.url)).arrayBuffer()));
  };
  const today = now.toISOString().slice(0, 10);
  const due = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);

  let w: Workspace;
  beforeAll(async () => {
    w = await workspace();
  });

  it("exports the month's invoices", async () => {
    const [header, ...rows] = await exportOf(w.staff, 'accounting_invoices');
    expect(header).toEqual(['Invoice ID', 'Order', 'Customer', 'Created on', 'Due on', 'Status', 'Paid on', 'Lines', 'Shipping', 'Tax', 'Total', 'Currency', 'Provider invoice ID']);
    expect(rows).toEqual([
      [w.ids.paidInvoice, String(w.lunaOrder.number), 'Luna Jewels', today, due, 'paid', today, '100.00', '9.90', '19.00', '128.90', 'EUR', 'in_luna'],
      [w.ids.openInvoice, String(w.solOrder.number), 'Sol Studio', today, due, 'open', '', '100.00', '9.90', '19.00', '128.90', 'EUR', 'in_sol'],
    ]);
  });

  it("exports the month's payments with their fees, a reversal as its own negative row", async () => {
    const [header, ...rows] = await exportOf(w.staff, 'accounting_payments');
    expect(header).toEqual(['Journal ID', 'Occurred at', 'Order', 'Customer', 'Amount', 'Fee', 'Net', 'Currency', 'Method', 'Provider reference']);
    expect(rows.map((row) => [row[0], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9]])).toEqual([
      [w.ids.provider, String(w.lunaOrder.number), 'Luna Jewels', '119.00', '3.75', '115.25', 'EUR', 'provider', 'cs_luna'],
      [w.ids.byHand, String(w.solOrder.number), 'Sol Studio', '50.00', '0.00', '50.00', 'EUR', 'outside', ''],
      [w.ids.reversed, String(w.solOrder.number), 'Sol Studio', '30.00', '0.00', '30.00', 'EUR', 'provider', 'cs_sol'],
      [w.ids.reversal, String(w.solOrder.number), 'Sol Studio', '-30.00', '0.00', '-30.00', 'EUR', 'provider', 'cs_sol'],
    ]);
    expect(rows.every((row) => row[1].startsWith(month) && row[1].endsWith('+00:00'))).toBe(true);
  });

  it("exports the month's refunds and payouts with their status", async () => {
    const [refundHeader, ...refunds] = await exportOf(w.staff, 'accounting_refunds');
    expect(refundHeader).toEqual(['Refund ID', 'Order', 'Customer', 'Created on', 'Amount', 'Currency', 'Kind', 'Status', 'Reason']);
    expect(refunds).toEqual([
      [w.ids.refunded, String(w.lunaOrder.number), 'Luna Jewels', today, '20.00', 'EUR', 'outside', 'succeeded', 'Scratched'],
      [w.ids.refundFailed, String(w.solOrder.number), 'Sol Studio', today, '10.00', 'EUR', 'outside', 'failed', 'Scratched'],
    ]);

    const [payoutHeader, ...payouts] = await exportOf(w.staff, 'accounting_payouts');
    expect(payoutHeader).toEqual(['Payout ID', 'Partner', 'Created on', 'Settled on', 'Amount', 'Currency', 'Status', 'Failure', 'Provider transfer ID']);
    expect(payouts).toEqual([
      [w.ids.paid, 'CastCo Ltd', today, today, '80.00', 'EUR', 'paid', '', 'tr_paid'],
      [w.ids.payoutFailed, 'CastCo Ltd', today, '', '40.00', 'EUR', 'failed', 'Account closed', ''],
    ]);
  });

  it('counts a reversal, a failed refund and a failed payout once each, with their status (Review Focus 4)', async () => {
    const [, ...payments] = await exportOf(w.staff, 'accounting_payments');
    const net = payments.reduce((sum, row) => sum.add(row[6]), d('0'));
    // What reached the provider's balance or the bank this month, from the ledger itself.
    const ledgerNet = await prisma.inTenant(w.tenantId, async (tx) => {
      const lines = await tx.ledgerLine.findMany({
        where: {
          account: { in: ['stripe_balance', 'outside_stripe'] },
          journal: {
            occurredAt: { gte: new Date(`${month}-01T00:00:00Z`) },
            OR: [{ kind: { in: ['payment_received', 'provider_fee'] } }, { kind: 'reversal', reverses: { kind: { in: ['payment_received', 'provider_fee'] } } }],
          },
        },
        select: { amount: true },
      });
      return lines.reduce((sum, line) => sum.add(line.amount), d('0'));
    });
    expect(net.toFixed(2)).toBe('165.25');
    expect(net.toFixed(2)).toBe(ledgerNet.toFixed(2));
    expect(new Set(payments.map((row) => row[0])).size).toBe(payments.length);
  });

  it('refuses a month in the future, and without payment.read', async () => {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
    await w.staff.post('/reports/exports', { kind: 'accounting_invoices', params: { month: next } }).expect(400);
    await w.staff.post('/reports/exports', { kind: 'accounting_invoices', params: { month: '2026-13' } }).expect(400);
    await w.staff.post('/reports/exports', { kind: 'accounting_invoices', params: {} }).expect(400);
    for (const kind of ['accounting_invoices', 'accounting_payments', 'accounting_refunds', 'accounting_payouts']) {
      await w.reader.post('/reports/exports', { kind, params: { month } }).expect(403);
    }
  });
});
