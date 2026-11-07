import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { seedCatalog, seedPlaceholderDesign } from '../src/cli/seed-catalog';
import { seedCustomers } from '../src/cli/seed-customers';
import { seedDemoOrders } from '../src/cli/seed-demo-orders';
import { seedOrders } from '../src/cli/seed-orders';
import { seedPartners } from '../src/cli/seed-partners';
import { seedPayments } from '../src/cli/seed-payments';
import { seedPricing } from '../src/cli/seed-pricing';
import { seedProduction } from '../src/cli/seed-production';
import { seedWorkflows } from '../src/cli/seed-workflows';
import { PrismaService } from '../src/database/prisma.service';
import { CourierAccountService } from '../src/modules/couriers/courier-account.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { orderCountsResponseSchema, orderResponseSchema } from '../src/modules/orders/order-response';
import { OrderStatesService } from '../src/modules/orders/order-states.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { JobsService } from '../src/modules/partners/jobs.service';
import { InvoicesService } from '../src/modules/payments/invoices.service';
import { PaidByHandService } from '../src/modules/payments/paid-by-hand.service';
import { PaymentAccountService } from '../src/modules/payments/payment-account.service';
import { PayoutAccountsService } from '../src/modules/payments/payout-accounts.service';
import { RefundsService } from '../src/modules/payments/refunds.service';
import { QuotesService } from '../src/modules/pricing/quotes.service';
import { MovesService } from '../src/modules/workflow/moves.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'demo-password-123';
// The fake payment provider takes any keys; with them the demo has a payment account, so pay-later orders are invoiced.
const KEYS = {
  secretKey: 'sk_test_51SecretValueAAAA',
  publishableKey: 'pk_test_51PublishableBBBB',
  webhookSecret: 'whsec_paymentsCCCC',
  connectWebhookSecret: 'whsec_connectDDDD',
};

interface Order {
  id: string;
  number: number;
  customer: { name: string };
  lines: { partner: { status: string; expires_at: string | null } | null }[];
  payment: { state: string };
}

/**
 * The demo orders seed: after the rest of the demo, `GET /orders/counts` has something in every tab and
 * every needs-you reason, and a second run changes nothing.
 */
describe('demo orders seed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  const deps = () => ({
    prisma,
    quotes: app.get(QuotesService),
    orders: app.get(OrdersService),
    states: app.get(OrderStatesService),
    paidByHand: app.get(PaidByHandService),
    refunds: app.get(RefundsService),
    invoices: app.get(InvoicesService),
    jobs: app.get(JobsService),
    moves: app.get(MovesService),
  });

  // 20 orders, each quoted, placed, paid, handed to its workshop and moved through every step through the
  // services, on top of the whole demo: far more work than one request, so it gets more than the usual 20 s.
  it('fills every tab and every needs-you reason, once', async () => {
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

    const first = await seedDemoOrders(deps(), tenant.id, owner.id);
    expect(first).toMatchObject({ customers: 6, orders: 20, notInvoiced: 0 });

    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const get = (path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`).expect(200);
    const counts = (await get('/orders/counts')).body as { all: number; states: Record<string, number>; needs_you: Record<string, number> };
    expectDocumented(orderCountsResponseSchema, counts);
    expect(counts).toEqual({
      all: 20,
      states: { awaiting_payment: 2, in_production: 8, ready: 4, shipped: 3, delivered: 1, cancelled: 2 },
      needs_you: { total: 10, late: 2, to_ship: 4, to_collect: 3, due_soon: 2 },
    });
    expect(first.counts).toEqual(counts);

    const list = await get('/orders?limit=100');
    expectDocumented(pageSchema(orderResponseSchema), list.body);
    const orders = (list.body as { data: Order[] }).data;
    // Every payment state the filter offers, a three-line order, and the 40-character customer.
    expect([...new Set(orders.map((order) => order.payment.state))].sort()).toEqual(
      ['awaiting_payment', 'invoiced', 'none', 'not_billed', 'overdue', 'paid', 'partly_refunded', 'refunded'],
    );
    expect(orders.some((order) => order.lines.length === 3)).toBe(true);
    expect(orders.some((order) => order.customer.name.length === 40)).toBe(true);
    // Numbered from 1001 oldest first, as `-placed_at` lists them newest first.
    expect(orders.map((order) => order.number)).toEqual(Array.from({ length: 20 }, (_, index) => 1020 - index));

    // One line offered to its workshop and not answered yet, open for 30 days from the seed.
    const offeredId = await prisma.inTenant(tenant.id, async (tx) => (await tx.order.findFirstOrThrow({ where: { channelOrderId: 'demo:offered' } })).id);
    const offered = orders.find((order) => order.id === offeredId)!;
    const partner = offered.lines[0].partner!;
    expect(partner.status).toBe('offered');
    const days = (Date.parse(partner.expires_at!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);

    const second = await seedDemoOrders(deps(), tenant.id, owner.id);
    expect(second).toMatchObject({ customers: 0, orders: 0, notInvoiced: 0 });
    expect((await get('/orders/counts')).body).toEqual(counts);
  }, 180_000);
});
