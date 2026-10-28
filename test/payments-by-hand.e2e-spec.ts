import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { orderResponseSchema } from '../src/modules/orders/order-response';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { LedgerService } from '../src/modules/payments/ledger.service';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { sendEvent } from './payment-webhooks';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface StaffOrder {
  id: string;
  state: string;
  total: string;
  lines: { group_id: string }[];
  payment: { state: string; paid: string; pay_url: string | null; invoice: { status: string } | null };
}

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const NO_KEYS = { secretKey: '' };

/** The real jobs, with a tiny backoff so a retry happens within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'payments.event': { ...JOBS['payments.event'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/**
 * Paid by hand (Payments plan, Task 9): staff record a payment made outside the provider, such as a
 * bank transfer. A waiting order is billed, paid and started; an open invoice is paid, and marked so
 * at the provider. No fee, and nothing else can be paid this way.
 */
describe('payments: paid by hand', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakePaymentProvider;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  /**
   * The priced cast part, published; `courier` at 9.90; tax at 19 %; the workspace's payment keys;
   * Anna's studio paying first; Brightline paying later within 30 days; Corvid paying later with no
   * credit at all, so each of its orders is held.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '19' }] }).expect(200);
    await staff.put('/payments/account', KEYS).expect(200);

    const customer = async (name: string, terms: object | null) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      if (terms) await staff.put(`/customers/${id}/payment-terms`, terms).expect(200);
      return id;
    };
    const anna = await customer('Anna Studio', null);
    const brightline = await customer('Brightline', { terms: 'pay_later', days_to_pay: 30 });
    const corvid = await customer('Corvid', { terms: 'pay_later', credit_limit: '0.00' });

    /** An order of one line, placed by staff. */
    const place = async (customerId: string) => {
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
      ).body as { quote: { id: string } }).quote.id;
      return (
        await staff
          .post('/orders', {
            customer_id: customerId,
            lines: [{ quote_id: quote }],
            address: { name: 'Customer', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
            shipping_method: 'courier',
          })
          .expect(201)
      ).body as StaffOrder;
    };

    return {
      id: tenant.id,
      ownerId: owner.id,
      staff,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      anna,
      brightline,
      corvid,
      place,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const paidByHand = (tenant: Tenant, orderId: string, body: object, by = tenant.staff) => by.post(`/orders/${orderId}/paid-by-hand`, body);
  const staffView = async (tenant: Tenant, orderId: string) => (await tenant.staff.get(`/orders/${orderId}`).expect(200)).body as StaffOrder;
  const journals = (tenant: Tenant, orderId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.ledgerJournal.findMany({ where: { orderId }, include: { lines: true }, orderBy: { id: 'asc' } }));
  const raised = (tenant: Tenant, eventKey: string, orderId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey, subjectId: orderId } }));
  const balance = (tenant: Tenant, account: 'customer_receivable' | 'outside_stripe' | 'stripe_balance', orderId: string) =>
    prisma.inTenant(tenant.id, (tx) => app.get(LedgerService).balance(tx, account, { orderId }));
  /** Every piece finished directly, then shipped, and the invoice the job makes once it is open. */
  const shipAndInvoice = async (tenant: Tenant, order: StaffOrder) => {
    await prisma.inTenant(tenant.id, (tx) =>
      tx.workOrder.updateMany({ where: { groupId: { in: order.lines.map((line) => line.group_id) } }, data: { status: 'finished', currentStepId: null } }),
    );
    await tenant.staff.post(`/orders/${order.id}/ship`, {}).expect(200);
    return waitFor(() =>
      prisma.inTenant(tenant.id, async (tx) => {
        const row = await tx.invoice.findFirst({ where: { orderId: order.id, status: 'open' } });
        return row ? { ...row, providerInvoiceId: row.providerInvoiceId! } : undefined;
      }),
    );
  };

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JOB_REGISTRY)
      .useValue(fixture)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    fake = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
    // The worker makes the invoices and applies the webhooks with its own provider instance, which sees what the app's saw.
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('bills, pays and starts a waiting pay-first order paid outside the provider, without a fee', async () => {
    const tenant = await freshTenant();
    const placed = await tenant.place(tenant.anna);
    const checkout = await prisma.inTenant(tenant.id, (tx) => tx.orderPayment.findFirstOrThrow({ where: { orderId: placed.id, status: 'open' } }));

    const res = await paidByHand(tenant, placed.id, { reference: 'Bank transfer 2026-0042', received_on: today() }).expect(200);

    expectDocumented(orderResponseSchema, res.body);
    expect(res.body).toMatchObject({ state: 'in_production', payment: { state: 'paid', paid: placed.total, pay_url: null } });
    // Its checkout can't be paid as well.
    expect((await prisma.inTenant(tenant.id, (tx) => tx.orderPayment.findUniqueOrThrow({ where: { id: checkout.id } }))).status).toBe('expired');
    expect((await fake.getCheckout(NO_KEYS, checkout.providerCheckoutId!)).status).toBe('expired');

    const posted = await journals(tenant, placed.id);
    expect(posted.map((journal) => journal.kind)).toEqual(['order_billed', 'payment_received']);
    expect(posted[1].lines.map((line) => line.account).sort()).toEqual(['customer_receivable', 'outside_stripe']);
    expect(posted[1].occurredAt.toISOString().slice(0, 10)).toBe(today());
    expect((await balance(tenant, 'outside_stripe', placed.id)).toFixed(2)).toBe(placed.total);
    expect((await balance(tenant, 'customer_receivable', placed.id)).toFixed(2)).toBe('0.00');
    expect((await balance(tenant, 'stripe_balance', placed.id)).toFixed(2)).toBe('0.00');

    expect(await raised(tenant, 'payment.received', placed.id)).toBe(1);
    const audited = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.findFirstOrThrow({ where: { action: 'order.paid_by_hand', subjectId: placed.id } }),
    );
    expect(audited).toMatchObject({
      actorId: tenant.ownerId,
      after: { reference: 'Bank transfer 2026-0042', received_on: today(), amount: placed.total },
    });

    // Paid already: nothing is paid twice.
    await paidByHand(tenant, placed.id, { reference: 'Again', received_on: today() }).expect(409);
    expect(await journals(tenant, placed.id)).toHaveLength(2);
  });

  it('starts an order held for its credit limit once it is paid by hand', async () => {
    const tenant = await freshTenant();
    const held = await tenant.place(tenant.corvid);
    expect(held.payment.state).toBe('awaiting_payment');

    const res = await paidByHand(tenant, held.id, { reference: 'Cash at the counter', received_on: today() }).expect(200);

    expect(res.body).toMatchObject({ state: 'in_production', payment: { state: 'paid', paid: held.total } });
  });

  it('pays an open invoice by hand, marks it paid outside at the provider, and a late webhook posts nothing', async () => {
    const tenant = await freshTenant();
    const placed = await tenant.place(tenant.brightline);
    const invoice = await shipAndInvoice(tenant, placed);

    const res = await paidByHand(tenant, placed.id, { reference: 'Bank transfer 2026-0043', received_on: today() }).expect(200);

    expectDocumented(orderResponseSchema, res.body);
    expect(res.body).toMatchObject({ payment: { state: 'paid', paid: placed.total, pay_url: null, invoice: { status: 'paid' } } });
    expect(await prisma.inTenant(tenant.id, (tx) => tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))).toMatchObject({
      status: 'paid',
      paidAt: expect.any(Date),
    });
    // Paid outside: paid at the provider, with no fee there.
    const atProvider = await fake.getInvoice(NO_KEYS, invoice.providerInvoiceId);
    expect(atProvider).toMatchObject({ status: 'paid', paid: true });
    expect(atProvider.fee.toFixed(2)).toBe('0.00');
    expect((await journals(tenant, placed.id)).map((journal) => journal.kind)).toEqual(['order_billed', 'payment_received']);
    expect((await balance(tenant, 'outside_stripe', placed.id)).toFixed(2)).toBe(placed.total);
    expect((await balance(tenant, 'customer_receivable', placed.id)).toFixed(2)).toBe('0.00');

    // The provider tells of the invoice it now holds as paid: nothing more is posted or told.
    await sendEvent(app, tenant.id, { id: `evt_${newId().replaceAll('-', '')}`, type: 'invoice.paid', objectId: invoice.providerInvoiceId });
    expect(await journals(tenant, placed.id)).toHaveLength(2);
    expect((await balance(tenant, 'stripe_balance', placed.id)).toFixed(2)).toBe('0.00');
    expect(await raised(tenant, 'payment.received', placed.id)).toBe(1);
    await paidByHand(tenant, placed.id, { reference: 'Again', received_on: today() }).expect(409);
  });

  it('refuses an order with nothing to pay, a future or missing date, an empty reference, and a member', async () => {
    const tenant = await freshTenant();
    // Pay later and not shipped: nothing is billed yet.
    const notBilled = await tenant.place(tenant.brightline);
    const waiting = await tenant.place(tenant.anna);
    const cancelled = await tenant.place(tenant.anna);
    await tenant.staff.post(`/orders/${cancelled.id}/cancel`, { reason: 'Changed their mind' }).expect(200);
    const valid = { reference: 'Bank transfer', received_on: today() };

    await paidByHand(tenant, notBilled.id, valid).expect(409);
    await paidByHand(tenant, cancelled.id, valid).expect(409);
    await paidByHand(tenant, waiting.id, { ...valid, received_on: tomorrow() }).expect(400);
    await paidByHand(tenant, waiting.id, { reference: 'Bank transfer' }).expect(400);
    await paidByHand(tenant, waiting.id, { ...valid, reference: '' }).expect(400);
    await paidByHand(tenant, waiting.id, { ...valid, reference: 'x'.repeat(201) }).expect(400);
    await paidByHand(tenant, waiting.id, valid, tenant.member).expect(403);
    await paidByHand(tenant, newId(), valid).expect(404);

    expect(await prisma.inTenant(tenant.id, (tx) => tx.ledgerJournal.count())).toBe(0);
    expect((await staffView(tenant, waiting.id)).state).toBe('awaiting_payment');
  });
});
