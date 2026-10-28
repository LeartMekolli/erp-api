import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { customerOrderResponseSchema, orderResponseSchema } from '../src/modules/orders/order-response';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { InvoiceHandler } from '../src/modules/payments/invoice.handler';
import { LedgerService } from '../src/modules/payments/ledger.service';
import { OverdueInvoicesHandler } from '../src/modules/payments/overdue-invoices.handler';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { paymentCustomerResponseSchema } from '../src/modules/payments/payment-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { sendEvent } from './payment-webhooks';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface StaffOrder {
  id: string;
  number: number;
  state: string;
  total: string;
  shipping: { price: string };
  tax: { percent: string };
  lines: { position: number; total: string; group_id: string }[];
  payment: {
    state: string;
    paid: string;
    pay_url: string | null;
    invoice: { url: string; due_on: string; status: string } | null;
  };
}

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const NO_KEYS = { secretKey: '' };
const DAYS_TO_PAY = 30;
const d = (value: string) => new Prisma.Decimal(value);

/** The real jobs, with a tiny backoff so a retry happens within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'payments.event': { ...JOBS['payments.event'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

/** `day` plus `days`, both `YYYY-MM-DD`. */
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** Today in `timezone`, as `YYYY-MM-DD`. */
const todayIn = (timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());

/**
 * Invoices on shipping (Payments plan, Task 8): a pay-later order not paid is invoiced once it ships,
 * for its live lines, shipping and tax, due in the customer's days to pay. The invoice is paid by
 * webhook, and one past its due date is told about once. An order paid by card is never invoiced.
 */
describe('payments: invoices on shipping', () => {
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

  async function person(tenantId: string, customerId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind: 'customer' } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'customer', organisationId: customerId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /**
   * The priced cast part, published; `courier` at 9.90; tax at 19 %; the workspace's payment keys;
   * Brightline paying later within 30 days, with an owner; Anna's studio paying first; Corvid paying
   * later with no credit at all, so each of its orders is held.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
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
    const brightline = await customer('Brightline', { terms: 'pay_later', days_to_pay: DAYS_TO_PAY });
    const anna = await customer('Anna Studio', null);
    const corvid = await customer('Corvid', { terms: 'pay_later', credit_limit: '0.00' });

    const quote = async (customerId: string) =>
      ((
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
    /** An order placed by staff, of `lines` lines. */
    const place = async (customerId: string, lines = 1) => {
      const quotes = [];
      for (let i = 0; i < lines; i += 1) quotes.push({ quote_id: await quote(customerId) });
      return (
        await staff
          .post('/orders', {
            customer_id: customerId,
            lines: quotes,
            address: { name: 'Brightline', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
            shipping_method: 'courier',
          })
          .expect(201)
      ).body as StaffOrder;
    };

    return {
      id: tenant.id,
      timezone: (await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).timezone,
      staff,
      brightline,
      brightlineOwner: await person(tenant.id, brightline, 'owner'),
      anna,
      corvid,
      place,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const staffView = async (tenant: Tenant, orderId: string) => (await tenant.staff.get(`/orders/${orderId}`).expect(200)).body as StaffOrder;
  /** Every piece finished directly, then shipped: moving pieces through every step is Workflow's to test. */
  const finishAndShip = async (tenant: Tenant, order: StaffOrder) => {
    await prisma.inTenant(tenant.id, (tx) =>
      tx.workOrder.updateMany({
        where: { groupId: { in: order.lines.map((line) => line.group_id) } },
        data: { status: 'finished', currentStepId: null },
      }),
    );
    await tenant.staff.post(`/orders/${order.id}/ship`, {}).expect(200);
  };
  const invoices = (tenant: Tenant, orderId: string) => prisma.inTenant(tenant.id, (tx) => tx.invoice.findMany({ where: { orderId } }));
  /** The invoice the job made for the shipped order, once it is open at the provider. */
  const invoiced = (tenant: Tenant, orderId: string) =>
    waitFor(() =>
      prisma.inTenant(tenant.id, async (tx) => {
        const row = await tx.invoice.findFirst({ where: { orderId, status: 'open' } });
        return row ? { ...row, providerInvoiceId: row.providerInvoiceId! } : undefined;
      }),
    );
  const runInvoiceJob = (tenant: Tenant, orderId: string) => app.get(InvoiceHandler).handle({ tenantId: tenant.id, orderId });
  const runOverdue = () => app.get(OverdueInvoicesHandler).handle();
  const journals = (tenant: Tenant, orderId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.ledgerJournal.findMany({ where: { orderId }, include: { lines: true }, orderBy: { id: 'asc' } }));
  const raised = (tenant: Tenant, eventKey: string, orderId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey, subjectId: orderId } }));
  const event = (type: string, objectId: string) => ({ id: `evt_${newId().replaceAll('-', '')}`, type, objectId });
  /** The customer pays the order's open checkout at the provider, and the provider tells us. */
  const payByCard = async (tenant: Tenant, orderId: string) => {
    const checkout = await prisma.inTenant(tenant.id, (tx) => tx.orderPayment.findFirstOrThrow({ where: { orderId, status: 'open' } }));
    fake.completeCheckout(checkout.providerCheckoutId!);
    await sendEvent(app, tenant.id, event('checkout.session.completed', checkout.providerCheckoutId!));
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

  it('invoices a shipped pay-later order once, due in its days to pay, and bills it in the ledger', async () => {
    const tenant = await freshTenant();
    const placed = await tenant.place(tenant.brightline);
    await finishAndShip(tenant, placed);

    const invoice = await invoiced(tenant, placed.id);

    expect(invoice).toMatchObject({ currency: 'EUR', dueOn: new Date(`${addDays(todayIn(tenant.timezone), DAYS_TO_PAY)}T00:00:00Z`) });
    expect(invoice.total.toFixed(2)).toBe(placed.total);
    expect(invoice.shipping.toFixed(2)).toBe(placed.shipping.price);
    expect(invoice.linesAmount.plus(invoice.shipping).plus(invoice.tax).toFixed(2)).toBe(placed.total);
    expect((await fake.getInvoice(NO_KEYS, invoice.providerInvoiceId)).amount.toFixed(2)).toBe(placed.total);

    const order = await staffView(tenant, placed.id);
    expectDocumented(orderResponseSchema, order);
    expect(order.payment).toMatchObject({
      state: 'invoiced',
      pay_url: invoice.url,
      invoice: { url: invoice.url, due_on: addDays(todayIn(tenant.timezone), DAYS_TO_PAY), status: 'open' },
    });
    const seen = await tenant.brightlineOwner.get(`/portal/customers/${tenant.brightline}/orders/${placed.id}`).expect(200);
    expectDocumented(customerOrderResponseSchema, seen.body);
    expect(seen.body).toMatchObject({ payment: { state: 'invoiced', invoice: { url: invoice.url, status: 'open' } } });

    // Billed once: the customer owes the total.
    const posted = await journals(tenant, placed.id);
    expect(posted.map((journal) => journal.kind)).toEqual(['order_billed']);
    expect(posted[0].lines.reduce((sum, line) => sum.plus(line.amount), d('0')).toFixed(2)).toBe('0.00');
    expect(await raised(tenant, 'invoice.sent', placed.id)).toBe(1);
    expect((await prisma.inTenant(tenant.id, (tx) => tx.customerPaymentTerms.findUniqueOrThrow({ where: { customerId: tenant.brightline } }))).providerCustomerId).toEqual(
      expect.any(String),
    );

    const money = await tenant.staff.get(`/payments/customers/${tenant.brightline}`).expect(200);
    expectDocumented(paymentCustomerResponseSchema, money.body);
    expect(money.body).toMatchObject({
      balance: placed.total,
      exposure: placed.total,
      open_invoices: [{ order_id: placed.id, order_number: placed.number, total: placed.total, url: invoice.url }],
      overdue_invoices: [],
    });

    // The job run again: the same invoice, at the provider too, and nothing posted or told twice.
    await runInvoiceJob(tenant, placed.id);
    const again = await invoices(tenant, placed.id);
    expect(again).toHaveLength(1);
    expect(again[0].providerInvoiceId).toBe(invoice.providerInvoiceId);
    expect(await journals(tenant, placed.id)).toHaveLength(1);
    expect(await raised(tenant, 'invoice.sent', placed.id)).toBe(1);
  });

  it('invoices only the lines left after one was cancelled', async () => {
    const tenant = await freshTenant();
    const placed = await tenant.place(tenant.brightline, 2);
    await tenant.staff.post(`/orders/${placed.id}/cancel`, { reason: 'One is enough', lines: [1] }).expect(200);
    await finishAndShip(tenant, { ...placed, lines: [placed.lines[0]] });

    const invoice = await invoiced(tenant, placed.id);

    const lines = d(placed.lines[0].total);
    const tax = lines.plus(placed.shipping.price).mul(placed.tax.percent).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const total = lines.plus(placed.shipping.price).plus(tax).toFixed(2);
    expect(invoice.linesAmount.toFixed(2)).toBe(lines.toFixed(2));
    expect(invoice.total.toFixed(2)).toBe(total);
    expect((await fake.getInvoice(NO_KEYS, invoice.providerInvoiceId)).amount.toFixed(2)).toBe(total);
  });

  it('marks an invoice paid by its webhook, journals the payment and its fee, once', async () => {
    const tenant = await freshTenant();
    const placed = await tenant.place(tenant.brightline);
    await finishAndShip(tenant, placed);
    const invoice = await invoiced(tenant, placed.id);
    fake.payInvoice(invoice.providerInvoiceId);

    await sendEvent(app, tenant.id, event('invoice.paid', invoice.providerInvoiceId));

    expect(await staffView(tenant, placed.id)).toMatchObject({
      payment: { state: 'paid', paid: placed.total, invoice: { status: 'paid' } },
    });
    const row = (await invoices(tenant, placed.id))[0];
    expect(row).toMatchObject({ status: 'paid', paidAt: expect.any(Date) });
    expect((await journals(tenant, placed.id)).map((journal) => journal.kind)).toEqual(['order_billed', 'payment_received', 'provider_fee']);
    const fee = (await fake.getInvoice(NO_KEYS, invoice.providerInvoiceId)).fee;
    const ledger = app.get(LedgerService);
    const balances = await prisma.inTenant(tenant.id, async (tx) => ({
      receivable: await ledger.balance(tx, 'customer_receivable', { customerId: tenant.brightline }),
      fees: await ledger.balance(tx, 'provider_fees', { orderId: placed.id }),
    }));
    expect(balances.receivable.toFixed(2)).toBe('0.00');
    expect(balances.fees.toFixed(2)).toBe(fee.toFixed(2));
    expect(await raised(tenant, 'payment.received', placed.id)).toBe(1);

    // Told again, in either form: nothing changes.
    await sendEvent(app, tenant.id, event('invoice.paid', invoice.providerInvoiceId));
    await sendEvent(app, tenant.id, event('invoice.payment_succeeded', invoice.providerInvoiceId));
    expect(await journals(tenant, placed.id)).toHaveLength(3);
    expect(await raised(tenant, 'payment.received', placed.id)).toBe(1);
  });

  it('ignores a paid event for an invoice the provider says is still open', async () => {
    const tenant = await freshTenant();
    const placed = await tenant.place(tenant.brightline);
    await finishAndShip(tenant, placed);
    const invoice = await invoiced(tenant, placed.id);

    await sendEvent(app, tenant.id, event('invoice.paid', invoice.providerInvoiceId));

    expect((await invoices(tenant, placed.id))[0].status).toBe('open');
    expect(await journals(tenant, placed.id)).toHaveLength(1);
  });

  it('tells the customer and staff of an invoice past its due date, once', async () => {
    const tenant = await freshTenant();
    const placed = await tenant.place(tenant.brightline);
    await finishAndShip(tenant, placed);
    const invoice = await invoiced(tenant, placed.id);
    // Due yesterday, and another invoice due today that is not overdue yet.
    const yesterday = addDays(todayIn(tenant.timezone), -1);
    await prisma.inTenant(tenant.id, (tx) => tx.invoice.update({ where: { id: invoice.id }, data: { dueOn: new Date(`${yesterday}T00:00:00Z`) } }));
    const onTime = await tenant.place(tenant.brightline);
    await finishAndShip(tenant, onTime);
    const due = await invoiced(tenant, onTime.id);
    await prisma.inTenant(tenant.id, (tx) =>
      tx.invoice.update({ where: { id: due.id }, data: { dueOn: new Date(`${todayIn(tenant.timezone)}T00:00:00Z`) } }),
    );

    await runOverdue();

    expect((await staffView(tenant, placed.id)).payment.state).toBe('overdue');
    expect((await staffView(tenant, onTime.id)).payment.state).toBe('invoiced');
    expect(await raised(tenant, 'invoice.overdue', placed.id)).toBe(1);
    expect(await raised(tenant, 'invoice.overdue.staff', placed.id)).toBe(1);
    expect(await raised(tenant, 'invoice.overdue', onTime.id)).toBe(0);
    const money = (await tenant.staff.get(`/payments/customers/${tenant.brightline}`).expect(200)).body as {
      open_invoices: { order_id: string }[];
      overdue_invoices: { order_id: string; due_on: string }[];
    };
    expect(money.overdue_invoices).toEqual([expect.objectContaining({ order_id: placed.id, due_on: yesterday })]);
    expect(money.open_invoices.map((row) => row.order_id)).toEqual([onTime.id]);

    await runOverdue();
    expect(await raised(tenant, 'invoice.overdue', placed.id)).toBe(1);
    expect(await raised(tenant, 'invoice.overdue.staff', placed.id)).toBe(1);
  });

  it('never invoices an order paid by card: pay first, or held for credit and paid', async () => {
    const tenant = await freshTenant();
    const payFirst = await tenant.place(tenant.anna);
    const held = await tenant.place(tenant.corvid);
    expect(held.payment).toMatchObject({ state: 'awaiting_payment' });
    for (const order of [payFirst, held]) {
      await payByCard(tenant, order.id);
      await finishAndShip(tenant, order);
      // Whatever the queued job decides, it decides the same when run here.
      await runInvoiceJob(tenant, order.id);
    }

    for (const order of [payFirst, held]) {
      expect(await invoices(tenant, order.id)).toEqual([]);
      expect((await staffView(tenant, order.id)).payment).toMatchObject({ state: 'paid', invoice: null });
    }
  });
});
