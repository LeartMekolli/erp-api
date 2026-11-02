import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { PriorityService } from '../src/modules/customers/priority/priority.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { localDate } from '../src/modules/orders/dates';
import { CreditsService } from '../src/modules/payments/credits/credits.service';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { ReportsService } from '../src/modules/reporting/reports.service';
import { addDays, weekOf } from '../src/modules/reporting/week-metrics';
import { measuredDesign } from './catalog-fixtures';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface Order {
  id: string;
  total: string;
  tax: { amount: string };
  address: object;
  lines: { group_id: string }[];
}

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const fixture: JobRegistry = { jobs: JOBS, scheduled: SCHEDULED_JOBS };
const DAY_MS = 86_400_000;

const STUDIO = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
const NEW_STUDIO = { name: 'Luna Jewels', line1: 'Torstraße 9', city: 'Berlin', postal_code: '10119', country: 'DE' };
const HEAD_OFFICE = { name: 'Luna Jewels GmbH', line1: 'Ringstraße 4', city: 'Wien', postal_code: '1010', region: 'Wien', country: 'AT' };
const MARE_STUDIO = { name: 'Mare Atelier', line1: 'Via Roma 2', city: 'Milano', postal_code: '20121', country: 'IT' };

/**
 * Customers 2 end to end: the spec's five "Done when" points in one workspace.
 *
 * Luna Jewels is Wholesale (0 %), orders three times and pays on time; Mare Atelier is in no group, orders
 * once and is late with its invoice; Sol Studio is new; Terra Rings joins Wholesale while a campaign for
 * the group runs. Gold starts at 80, is first in line and may pick a workshop; Silver starts at 50.
 */
describe('Customers 2 walkthrough', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakePaymentProvider;
  let priority: PriorityService;
  let reports: ReportsService;
  let credits: CreditsService;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const id = (response: request.Response) => (response.body as { id: string }).id;
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JOB_REGISTRY).useValue(fixture).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    fake = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
    priority = app.get(PriorityService);
    reports = app.get(ReportsService);
    credits = app.get(CreditsService);
    // The worker makes the invoices, with its own provider instance, which sees what the app's saw.
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('sorts customers into groups, keeps their addresses, scores them and treats the best first', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const timezone = (await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).timezone;
    const today = localDate(new Date(), timezone);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '19' }] }).expect(200);
    await staff.put('/payments/account', KEYS).expect(200);
    await staff
      .put('/settings/customers.priority', {
        weights: { lifetime: 1, recent: 1, frequency: 1, payment: 1 },
        defaultBand: { key: 'standard', name: 'Standard' },
        bands: [
          { key: 'gold', name: 'Gold', from: 80, firstInLine: true, mayPickPartner: true },
          { key: 'silver', name: 'Silver', from: 50, firstInLine: false, mayPickPartner: false },
        ],
      })
      .expect(200);

    const wholesale = id(await staff.post('/pricing/customer-groups', { key: 'wholesale', name: 'Wholesale', percent: '0' }).expect(201));
    const customer = async (name: string, groupId?: string) => {
      const created = id(await staff.post('/customers', { name, ...(groupId ? { customer_group_id: groupId } : {}) }).expect(201));
      await staff.put(`/customers/${created}/payment-terms`, { terms: 'pay_later', days_to_pay: 30 }).expect(200);
      return created;
    };
    const luna = await customer('Luna Jewels', wholesale);
    const mare = await customer('Mare Atelier');
    const sol = await customer('Sol Studio');
    const terra = await customer('Terra Rings');
    const lunaOwner = await (async () => {
      const user = await createTestUser(prisma, tenant.id, { roles: [] });
      await prisma.inTenant(tenant.id, async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { kind: 'customer' } });
        await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'customer', organisationId: luna, role: 'owner' } });
      });
      return as((await tokens.issueForUser(tenant.id, user.id)).accessToken);
    })();

    const place = async (customerId: string, quantity: number): Promise<Order> => {
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
      // No address: the order ships to the customer's saved one.
      return (await staff.post('/orders', { customer_id: customerId, lines: [{ quote_id: quote.id }], shipping_method: 'courier' }).expect(201)).body as Order;
    };
    const shipAndInvoice = async (order: Order) => {
      await prisma.inTenant(tenant.id, (tx) =>
        tx.workOrder.updateMany({ where: { groupId: { in: order.lines.map((line) => line.group_id) } }, data: { status: 'finished', currentStepId: null } }),
      );
      await staff.post(`/orders/${order.id}/ship`, {}).expect(200);
      return waitFor(() => prisma.inTenant(tenant.id, (tx) => tx.invoice.findFirst({ where: { orderId: order.id, status: 'open' } }).then((row) => row ?? undefined)));
    };
    const atProvider = async (customerId: string) => {
      const terms = await prisma.inTenant(tenant.id, (tx) => tx.customerPaymentTerms.findUniqueOrThrow({ where: { customerId } }));
      return fake.customerDetails(terms.providerCustomerId!);
    };
    const names = async (query: string) =>
      ((await staff.get(`/customers?limit=100&${query}`).expect(200)).body as { data: { name: string }[] }).data.map((row) => row.name).sort();

    // 1. Groups: the list by group and by none; a campaign for Wholesale reaches its customers once, and
    // one moved in later; the dashboard splits revenue by group, adding up to the total.
    expect(await names(`customer_group=${wholesale}`)).toEqual(['Luna Jewels']);
    expect(await names('customer_group=none')).toEqual(['Mare Atelier', 'Sol Studio', 'Terra Rings']);
    const campaign = id(
      await staff
        .post('/payments/campaigns', {
          name: 'Wholesale launch',
          credits_per_customer: 50,
          credit_days: 60,
          starts_at: new Date(Date.now() - 3_600_000).toISOString(),
          ends_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
          budget: 500,
          targets: { plan_ids: [], customer_ids: [], customer_group_ids: [wholesale] },
        })
        .expect(201),
    );
    await staff.post(`/payments/campaigns/${campaign}/activate`).expect(200);
    await staff.patch(`/customers/${terra}`, { customer_group_id: wholesale }).expect(200);
    const campaignCredits = (customerId: string) =>
      prisma.inTenant(tenant.id, async (tx) => (await credits.balance(tx, customerId, new Date())).by_source.campaign);
    expect([await campaignCredits(luna), await campaignCredits(terra), await campaignCredits(mare)]).toEqual([50, 50, 0]);

    // 2. Addresses: Luna's owner saves the shipping address in the portal; staff order without one and it
    // ships there; a later change leaves the order as it was.
    await lunaOwner.put(`/portal/customers/${luna}/addresses`, { shipping_address: STUDIO }).expect(200);
    await staff.put(`/customers/${mare}/addresses`, { shipping_address: MARE_STUDIO }).expect(200);
    const first = await place(luna, 8);
    expect(first.address).toEqual(STUDIO);
    const second = await place(luna, 7);
    const third = await place(luna, 6);
    const mareOrder = await place(mare, 1);
    await lunaOwner.put(`/portal/customers/${luna}/addresses`, { shipping_address: NEW_STUDIO }).expect(200);
    expect(((await staff.get(`/orders/${first.id}`).expect(200)).body as Order).address).toEqual(STUDIO);

    const { start } = weekOf(new Date(), 'UTC');
    const range = await reports.metricsFor(tenant.id, { from: start, to: addDays(start, 6) });
    const rows = range.orders.by_customer_group;
    expect(rows.map((row) => row.customer_group?.key ?? null)).toEqual(['wholesale', null]);
    expect(rows.reduce((sum, row) => sum.add(row.revenue), new Prisma.Decimal(0)).toFixed(2)).toBe(range.orders.revenue);

    // 3. Invoices: Luna's carries the billing address and VAT number; Mare's, without a billing address, the shipping one.
    await lunaOwner.put(`/portal/customers/${luna}/addresses`, { billing_address: HEAD_OFFICE, vat_number: 'ATU12345678' }).expect(200);
    await shipAndInvoice(third);
    expect(await atProvider(luna)).toEqual({ address: HEAD_OFFICE, vatNumber: 'ATU12345678' });
    const mareInvoice = await shipAndInvoice(mareOrder);
    expect(await atProvider(mare)).toEqual({ address: MARE_STUDIO, vatNumber: null });

    // 4. The nightly run: Mare's invoice is past due, Luna's isn't. Luna, frequent, punctual and the biggest
    // spender, is Gold; Sol, new, is Standard. Luna's pieces come first, and Luna may pick a workshop.
    await prisma.inTenant(tenant.id, (tx) => tx.invoice.update({ where: { id: mareInvoice.id }, data: { dueOn: new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS) } }));
    // The run itself: the test worker's hourly job may already have computed this workspace today, before
    // these orders, so `refreshDue` would rightly skip it (customers-priority tests the once-a-day rule).
    await priority.refresh(tenant.id, new Date());
    const band = async (customerId: string) => ((await staff.get(`/customers/${customerId}/priority`).expect(200)).body as { band: { key: string } }).band.key;
    expect(await staff.get(`/customers/${luna}/priority`).expect(200).then((response) => response.body as object)).toMatchObject({
      score: 100,
      band: { key: 'gold' },
      privileges: { first_in_line: true, may_pick_partner: true },
    });
    expect(await band(mare)).toBe('standard');
    expect(await band(sol)).toBe('standard');
    expect(await names('band=gold')).toEqual(['Luna Jewels']);

    const queue = ((await staff.get('/workflow/work-orders?limit=200').expect(200)).body as { data: { group_id: string }[] }).data;
    const lunaGroups = new Set([first, second, third].flatMap((order) => order.lines.map((line) => line.group_id)));
    const isLuna = queue.map((piece) => lunaGroups.has(piece.group_id));
    // Every one of Luna's 21 pieces (8 + 7 + 6), then Mare's one.
    expect(isLuna).toEqual([...Array<boolean>(21).fill(true), false]);

    const design = (await measuredDesign(prisma, tenant.id, owner.id, { customerId: luna })).versionId;
    await lunaOwner
      .post(`/portal/customers/${luna}/quotes/partners`, {
        product_id: cast.productId,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        file_version_id: design,
        quantity: 10,
      })
      .expect(200);
    expect(((await staff.get(`/customers/${luna}`).expect(200)).body as { may_pick_partner: boolean }).may_pick_partner).toBe(false);

    // 5. Staff put Sol in Gold until next Friday, with a reason: in force until then, audited; afterwards
    // the computed band is back.
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const nextFriday = new Date(Date.parse(`${today}T00:00:00Z`) + (((5 - weekday + 7) % 7) || 7) * DAY_MS).toISOString().slice(0, 10);
    await staff.put(`/customers/${sol}/priority/override`, { band_key: 'gold', reason: 'Launch partner this season', ends_on: nextFriday }).expect(200);
    expect(await band(sol)).toBe('gold');
    expect(await prisma.inTenant(tenant.id, (tx) => tx.auditEntry.count({ where: { subjectId: sol, action: 'customer.priority_changed' } }))).toBe(1);
    await prisma.inTenant(tenant.id, (tx) =>
      tx.customerPriority.update({
        where: { tenantId_customerId: { tenantId: tenant.id, customerId: sol } },
        data: { overrideEndsOn: new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS) },
      }),
    );
    expect(await band(sol)).toBe('standard');
  });
});
