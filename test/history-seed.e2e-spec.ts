import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog, seedPlaceholderDesign } from '../src/cli/seed-catalog';
import { seedCustomers } from '../src/cli/seed-customers';
import { seedDemoOrders } from '../src/cli/seed-demo-orders';
import { seedHistory } from '../src/cli/seed-history';
import { seedOrders } from '../src/cli/seed-orders';
import { seedPartners } from '../src/cli/seed-partners';
import { seedPayments } from '../src/cli/seed-payments';
import { seedPricing } from '../src/cli/seed-pricing';
import { seedProduction } from '../src/cli/seed-production';
import { seedWorkflows } from '../src/cli/seed-workflows';
import { PrismaService } from '../src/database/prisma.service';
import { CourierAccountService } from '../src/modules/couriers/courier-account.service';
import { TENANT_PERMISSIONS } from '../src/modules/identity/permissions';
import type { TenantAuth } from '../src/modules/identity/auth-context';
import { CommentsService } from '../src/modules/orders/comments.service';
import { OrderStatesService } from '../src/modules/orders/order-states.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { JobsService } from '../src/modules/partners/jobs.service';
import { InvoicesService } from '../src/modules/payments/invoices.service';
import { PaidByHandService } from '../src/modules/payments/paid-by-hand.service';
import { PaymentAccountService } from '../src/modules/payments/payment-account.service';
import { PayoutAccountsService } from '../src/modules/payments/payout-accounts.service';
import { RefundsService } from '../src/modules/payments/refunds.service';
import { QuotesService } from '../src/modules/pricing/quotes.service';
import { ReportsService } from '../src/modules/reporting/reports.service';
import { SettingsService } from '../src/modules/settings/settings.service';
import { MovesService } from '../src/modules/workflow/moves.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'demo-password-123';
const KEYS = {
  secretKey: 'sk_test_51SecretValueAAAA',
  publishableKey: 'pk_test_51PublishableBBBB',
  webhookSecret: 'whsec_paymentsCCCC',
  connectWebhookSecret: 'whsec_connectDDDD',
};
const DAY_MS = 86_400_000;
const addDays = (day: string, days: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The year of demo history (dashboard data plan, Task 7): about four finished orders a week, partner jobs
 * owed and paid by month, inspected fails with defects, and the on-time target.
 */
describe('history seed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdTenants: string[] = [];

  const deps = () => ({
    prisma,
    quotes: app.get(QuotesService),
    orders: app.get(OrdersService),
    states: app.get(OrderStatesService),
    paidByHand: app.get(PaidByHandService),
    jobs: app.get(JobsService),
  });
  const demoDeps = () => ({
    ...deps(),
    refunds: app.get(RefundsService),
    invoices: app.get(InvoicesService),
    moves: app.get(MovesService),
    comments: app.get(CommentsService),
  });

  let w: { id: string; ownerId: string };
  let now: Date;
  let made: { orders: number; payouts: number; pending: number };

  // The demo, then a year of orders, each quoted, placed, paid and handed to a workshop through the
  // services: far more work than one request, so it seeds once here, with much more than the usual 20 s.
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    w = await demo();
    now = new Date();
    made = await seedHistory(deps(), w.id, now);
  }, 900_000);

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  /** The demo as the history needs it: everything up to and including the demo orders. */
  async function demo() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const design = await seedPlaceholderDesign(prisma, tenant.id, owner.id);
    await seedCatalog(prisma, tenant.id, { partVersionId: design });
    await seedPricing(prisma, tenant.id);
    await seedWorkflows(prisma, tenant.id);
    await seedCustomers(prisma, tenant.id, { password: PASSWORD });
    await seedPartners(prisma, tenant.id, { password: PASSWORD });
    await seedOrders(prisma, tenant.id);
    await seedProduction({ prisma, accounts: app.get(CourierAccountService) }, tenant.id);
    await seedPayments({ prisma, accounts: app.get(PaymentAccountService), payoutAccounts: app.get(PayoutAccountsService) }, tenant.id, KEYS);
    await seedDemoOrders(demoDeps(), tenant.id, owner.id);
    return { id: tenant.id, ownerId: owner.id };
  }

  const historyOrders = (tenantId: string) =>
    prisma.inTenant(tenantId, (tx) => tx.order.count({ where: { channelOrderId: { startsWith: 'history:' } } }));
  const target = (tenantId: string) =>
    prisma.inTenant(tenantId, async (tx) => (await new SettingsService().list(tx))['reports.targets']);

  it('fills every week of the last 12 with orders, owed partner jobs and a defect', async () => {
    expect(made.orders).toBeGreaterThanOrEqual(52 * 3);
    expect(made.orders).toBeLessThanOrEqual(52 * 6);
    expect(made.payouts).toBeGreaterThan(0);

    // The last twelve whole weeks (Monday to Sunday) that end before the history's last day, 14 days back.
    const last = new Date(now.getTime() - 14 * DAY_MS).toISOString().slice(0, 10);
    const monday = addDays(last, -((new Date(`${last}T00:00:00Z`).getUTCDay() + 6) % 7));
    const to = addDays(monday, -1);
    const from = addDays(to, -83);

    const auth: TenantAuth = { scope: 'tenant', tenantId: w.id, userId: w.ownerId, jti: 'test', expiresAt: new Date(now.getTime() + 3_600_000), permissions: new Set(TENANT_PERMISSIONS) };
    const range = await app.get(ReportsService).range(auth, { from, to }, now);

    expect(range.range.bucket).toBe('week');
    expect(range.series).toHaveLength(12);
    expect(range.series.every((point) => point.orders_placed > 0)).toBe(true);
    expect(range.series.filter((point) => Number(point.partner_cost) > 0).length).toBeGreaterThanOrEqual(9);
    expect(range.current.production.defects_by_kind.length).toBeGreaterThan(0);
    expect(range.on_time_target).toBe(0.9);

    // Every history order is delivered; every payout is paid but the latest one, still on its way.
    expect(made.pending).toBe(1);
    const counts = await prisma.inTenant(w.id, async (tx) => ({
      undelivered: await tx.order.count({ where: { channelOrderId: { startsWith: 'history:' }, deliveredAt: null } }),
      delivered: await tx.order.count({ where: { channelOrderId: { startsWith: 'history:' }, deliveredAt: { not: null } } }),
      payouts: await tx.payout.count({ where: { status: { in: ['paid', 'pending'] } } }),
      pending: await tx.payout.count({ where: { status: 'pending', settledAt: null } }),
    }));
    expect(counts).toEqual({ undelivered: 0, delivered: made.orders, payouts: made.payouts, pending: 1 });
  });

  it('fails one piece in eight at its check step, one in nine of the check moves, and leaves no notification for a history order', async () => {
    const found = await prisma.inTenant(w.id, async (tx) => {
      // Per history order, at that order's own check step (final QC, or casting on a raw cast path): the demo
      // orders' fails sit at other steps, and other orders' moves from a shared step must not be counted.
      const ofHistory = { workOrder: { group: { orderLine: { order: { channelOrderId: { startsWith: 'history:' } } } } } };
      const moves = await tx.transition.findMany({ where: { ...ofHistory, inspected: true }, select: { kind: true, fromStepId: true, workOrder: { select: { groupId: true } } } });
      const failStep = new Map<string, string>();
      for (const move of moves) {
        if (move.kind === 'fail' && move.fromStepId) failStep.set(move.workOrder.groupId, move.fromStepId);
      }
      let fails = 0;
      let checked = 0;
      for (const move of moves) {
        if (failStep.get(move.workOrder.groupId) !== move.fromStepId) continue;
        checked++;
        if (move.kind === 'fail') fails++;
      }
      const lines = await tx.orderLine.findMany({ where: { order: { channelOrderId: { startsWith: 'history:' } } }, select: { orderId: true, groupId: true } });
      const jobs = await tx.jobAssignment.findMany({ where: { groupId: { in: lines.map((line) => line.groupId!) } }, select: { id: true } });
      const subjectIds = [...lines.map((line) => line.orderId), ...jobs.map((job) => job.id)];
      return { fails, checked, notifications: await tx.notification.count({ where: { subjectId: { in: subjectIds } } }) };
    });

    // The seed fails a piece when (plan index + piece number) % 8 === 5, so of an order's n pieces f = n / 8 on
    // average over the plan. Each piece is checked once, and a failed one again after its rework: n + f moves from
    // the check step, f of them fails, so fails / moves = f / (n + f) = (1 / 8) / (9 / 8) = 1 / 9 = 0.111.
    // Only orders with a fail are counted. A small order (2 to 5 pieces) can have a check step and no failed piece
    // by chance; leaving those out removes their n moves from the denominator and none of the fails. They are
    // a few percent of all pieces, so the ratio only moves up by a few percent of itself (under 0.01).
    expect(found.fails).toBeGreaterThan(0);
    const ratio = found.fails / found.checked;
    expect(ratio).toBeGreaterThan(1 / 9 - 0.01);
    expect(ratio).toBeLessThan(1 / 9 + 0.01);
    expect(found.notifications).toBe(0);
  });

  it('makes nothing the second time', async () => {
    expect(await historyOrders(w.id)).toBe(made.orders);

    expect(await seedHistory(deps(), w.id, now)).toEqual({ orders: 0, payouts: 0, pending: 1 });
    expect(await historyOrders(w.id)).toBe(made.orders);
  });

  it('keeps exactly one history payout pending, the newest, and settles one an earlier run left pending', async () => {
    const rows = await prisma.inTenant(w.id, (tx) => tx.payout.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } }));
    const newest = rows[0].id;
    const older = rows[rows.length - 1].id;
    expect(older).not.toBe(newest);
    // What an earlier run on another day leaves behind: an older payout still pending.
    await prisma.inTenant(w.id, (tx) => tx.payout.update({ where: { id: older }, data: { status: 'pending', settledAt: null, providerTransferId: null } }));

    expect(await seedHistory(deps(), w.id, now)).toEqual({ orders: 0, payouts: 0, pending: 1 });
    const pending = await prisma.inTenant(w.id, (tx) => tx.payout.findMany({ where: { status: 'pending' }, select: { id: true } }));
    expect(pending.map((row) => row.id)).toEqual([newest]);
    const settled = await prisma.inTenant(w.id, (tx) => tx.payout.findUniqueOrThrow({ where: { id: older } }));
    expect(settled).toMatchObject({ status: 'paid', settledAt: expect.any(Date), providerTransferId: expect.stringMatching(/^tr_history_/) });
  });

  it('sets the on-time target only when unset', async () => {
    expect(await target(w.id)).toEqual({ onTimeRate: 0.9 });

    await prisma.inTenant(w.id, (tx) => new SettingsService().set(tx, 'reports.targets', { onTimeRate: 0.75 }));
    await seedHistory(deps(), w.id, now);
    expect(await target(w.id)).toEqual({ onTimeRate: 0.75 });

    await prisma.inTenant(w.id, (tx) => tx.tenantSetting.deleteMany({ where: { key: 'reports.targets' } }));
    await seedHistory(deps(), w.id, now);
    expect(await target(w.id)).toEqual({ onTimeRate: 0.9 });
  });
});
