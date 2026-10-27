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
import { promisedDate } from '../src/modules/orders/dates';
import { DEFAULT_CALENDAR } from '../src/modules/orders/place-order';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { LedgerService } from '../src/modules/payments/ledger.service';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { orderPaymentsResponseSchema } from '../src/modules/payments/payment-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { sendEvent } from './payment-webhooks';
import { pricedCastPart } from './pricing-fixtures';
import { startTestWorker } from './worker-harness';

interface StaffOrder {
  id: string;
  state: string;
  promised_on: string;
  total: string;
  lines: { position: number; group_id: string; partner: { id: string } | null }[];
  payment: { state: string; paid: string; pay_url: string | null };
}

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const NO_KEYS = { secretKey: '' };
const WORKING_DAYS = 10;

/** The real jobs, with a tiny backoff so a retry happens within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'payments.event': { ...JOBS['payments.event'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

/**
 * A paid order starts production (Payments plan, Task 6): the checkout's webhook is checked against
 * the provider, the payment is journalled once, and the order starts as if placed at the moment it
 * was paid. Anything not ours, not paid, or sent twice changes nothing.
 */
describe('payments: a paid order starts production', () => {
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

  async function person(tenantId: string, kind: 'customer' | 'partner', organisationId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: kind, organisationId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /**
   * The priced cast part, published, promised in 10 working days; `courier` at 9.90; tax at 19 %; the
   * workspace's payment keys; MetalWorks taking direct orders for the whole cast line, with a member;
   * Anna's studio, paying first and allowed to pick a workshop, with a buyer.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const speeds = (await staff.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] };
    const standard = speeds.data.find((speed) => speed.key === 'standard')!;
    await staff.patch(`/pricing/delivery-speeds/${standard.id}`, { working_days: WORKING_DAYS }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '19' }] }).expect(200);
    await staff.put('/payments/account', KEYS).expect(200);

    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;
    const metalworks = ((await staff.post('/partners', { name: 'MetalWorks Ltd', display_name: 'MetalWorks' }).expect(201)).body as {
      id: string;
    }).id;
    await staff
      .put(`/partners/${metalworks}/capabilities`, {
        capabilities: [printPattern, castingTree, casting, polishing, finalQc, packing].map((step_type_id) => ({
          step_type_id,
          capacity: 200,
          capacity_period: 'week',
        })),
      })
      .expect(200);
    await staff.put(`/partners/${metalworks}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
    await staff.post(`/partners/${metalworks}/prices/copy-from-workspace`).expect(200);
    await staff.patch(`/partners/${metalworks}/limits`, { accepts_direct_orders: true }).expect(200);
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
    await staff.put(`/partners/${metalworks}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
    await staff.post(`/partners/${metalworks}/approve`).expect(200);

    const anna = ((await staff.post('/customers', { name: 'Anna Studio' }).expect(201)).body as { id: string }).id;
    await staff.patch(`/customers/${anna}`, { may_pick_partner: true }).expect(200);
    const design = (await measuredDesign(prisma, tenant.id, owner.id, { customerId: anna })).versionId;
    const buyer = await person(tenant.id, 'customer', anna, 'buyer');

    /** Anna's buyer orders at MetalWorks: the order waits for payment, holding the job. */
    const placeOrder = async () => {
      const quote = ((
        await buyer
          .post(`/portal/customers/${anna}/quotes`, {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 10,
            file_version_id: design,
            partner_id: metalworks,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote;
      const placed = await buyer
        .post(`/portal/customers/${anna}/orders`, {
          lines: [{ quote_id: quote.id }],
          address: { name: 'Anna Studio', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
          shipping_method: 'courier',
        })
        .expect(201);
      return (placed.body as { id: string }).id;
    };

    return {
      id: tenant.id,
      timezone: (await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).timezone,
      staff,
      buyer,
      anna,
      metalworks: { id: metalworks, person: await person(tenant.id, 'partner', metalworks, 'member') },
      placeOrder,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const staffView = async (tenant: Tenant, orderId: string) => (await tenant.staff.get(`/orders/${orderId}`).expect(200)).body as StaffOrder;
  const openCheckout = async (tenant: Tenant, orderId: string) => {
    const row = await prisma.inTenant(tenant.id, (tx) => tx.orderPayment.findFirstOrThrow({ where: { orderId, status: 'open' } }));
    return { ...row, providerCheckoutId: row.providerCheckoutId! };
  };
  const checkoutRow = (tenant: Tenant, id: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.orderPayment.findUniqueOrThrow({ where: { id } }));
  const journals = (tenant: Tenant, orderId: string) =>
    prisma.inTenant(tenant.id, (tx) =>
      tx.ledgerJournal.findMany({ where: { orderId }, include: { lines: true }, orderBy: { id: 'asc' } }),
    );
  const raised = (tenant: Tenant, eventKey: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey } }));
  const event = (type: string, objectId: string) => ({ id: `evt_${newId().replaceAll('-', '')}`, type, objectId });
  /** The customer pays at the provider, and the provider tells us. */
  const pay = async (tenant: Tenant, orderId: string) => {
    const checkout = await openCheckout(tenant, orderId);
    fake.completeCheckout(checkout.providerCheckoutId);
    const sent = event('checkout.session.completed', checkout.providerCheckoutId);
    await sendEvent(app, tenant.id, sent);
    return { checkout, sent };
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
    // The worker applies the webhooks with its own provider instance, which sees what the app's saw.
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('starts a paid order, journals the payment and its fee, and hands the job to the workshop', async () => {
    const tenant = await freshTenant();
    const orderId = await tenant.placeOrder();
    const total = (await staffView(tenant, orderId)).total;

    const { checkout } = await pay(tenant, orderId);

    const order = await staffView(tenant, orderId);
    expect(order).toMatchObject({ state: 'in_production', payment: { state: 'paid', paid: total, pay_url: null } });
    expect((await checkoutRow(tenant, checkout.id)).status).toBe('complete');

    // Billed, paid and the provider's fee: each balanced, the receivable back to nothing.
    const posted = await journals(tenant, orderId);
    expect(posted.map((journal) => journal.kind)).toEqual(['order_billed', 'payment_received', 'provider_fee']);
    for (const journal of posted) {
      expect(journal.lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0)).toFixed(2)).toBe('0.00');
    }
    const fee = (await fake.getCheckout(NO_KEYS, checkout.providerCheckoutId)).fee;
    const ledger = app.get(LedgerService);
    const balances = await prisma.inTenant(tenant.id, async (tx) => ({
      receivable: await ledger.balance(tx, 'customer_receivable', { customerId: tenant.anna }),
      fees: await ledger.balance(tx, 'provider_fees', { orderId }),
      stripe: await ledger.balance(tx, 'stripe_balance', { orderId }),
    }));
    expect(balances.receivable.toFixed(2)).toBe('0.00');
    expect(balances.fees.toFixed(2)).toBe(fee.toFixed(2));
    expect(balances.stripe.toFixed(2)).toBe(new Prisma.Decimal(total).minus(fee).toFixed(2));

    // The workshop sees its job now, and hears of it.
    const group = order.lines[0].group_id;
    const listed = await tenant.metalworks.person.get(`/partner-portal/partners/${tenant.metalworks.id}/jobs`).expect(200);
    expect(JSON.stringify(listed.body)).toContain(group);
    await tenant.metalworks.person.get(`/partner-portal/partners/${tenant.metalworks.id}/jobs/${group}`).expect(200);
    expect(await raised(tenant, 'partner.job.direct')).toBe(1);
    expect(await prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey: 'payment.received', subjectId: orderId } }))).toBe(1);
  });

  it('changes nothing when the same payment is told again, or a late expiry arrives', async () => {
    const tenant = await freshTenant();
    const orderId = await tenant.placeOrder();
    const { checkout } = await pay(tenant, orderId);

    await sendEvent(app, tenant.id, event('checkout.session.completed', checkout.providerCheckoutId));
    await sendEvent(app, tenant.id, event('checkout.session.async_payment_succeeded', checkout.providerCheckoutId));
    await sendEvent(app, tenant.id, event('checkout.session.expired', checkout.providerCheckoutId));

    expect(await journals(tenant, orderId)).toHaveLength(3);
    expect((await checkoutRow(tenant, checkout.id)).status).toBe('complete');
    expect(await raised(tenant, 'partner.job.direct')).toBe(1);
    expect(await prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey: 'payment.received' } }))).toBe(1);
  });

  it('marks an expired checkout expired, and the order waits for a new link', async () => {
    const tenant = await freshTenant();
    const orderId = await tenant.placeOrder();
    const checkout = await openCheckout(tenant, orderId);
    fake.expire(checkout.providerCheckoutId);

    await sendEvent(app, tenant.id, event('checkout.session.expired', checkout.providerCheckoutId));

    expect((await checkoutRow(tenant, checkout.id)).status).toBe('expired');
    expect(await staffView(tenant, orderId)).toMatchObject({ state: 'awaiting_payment', payment: { state: 'awaiting_payment', pay_url: null } });
  });

  it('ignores a completed event for a checkout the provider says is not paid', async () => {
    const tenant = await freshTenant();
    const orderId = await tenant.placeOrder();
    const checkout = await openCheckout(tenant, orderId);

    await sendEvent(app, tenant.id, event('checkout.session.completed', checkout.providerCheckoutId));

    expect((await checkoutRow(tenant, checkout.id)).status).toBe('open');
    expect(await journals(tenant, orderId)).toEqual([]);
    expect((await staffView(tenant, orderId)).state).toBe('awaiting_payment');
  });

  it('stores and applies a completed event for a checkout that is not ours, and changes nothing', async () => {
    const tenant = await freshTenant();
    const orderId = await tenant.placeOrder();
    const sent = event('checkout.session.completed', 'cs_not_ours_1');

    await sendEvent(app, tenant.id, sent);

    const stored = await prisma.inTenant(tenant.id, (tx) => tx.paymentEvent.findFirstOrThrow({ where: { providerEventId: sent.id } }));
    expect(stored.appliedAt).toBeInstanceOf(Date);
    expect(stored.error).toBeNull();
    expect(await prisma.inTenant(tenant.id, (tx) => tx.ledgerJournal.count())).toBe(0);
    expect((await staffView(tenant, orderId)).state).toBe('awaiting_payment');
  });

  it('counts the promised date and the workshop due date from the payment, not from placing', async () => {
    const tenant = await freshTenant();
    const orderId = await tenant.placeOrder();
    const group = (await staffView(tenant, orderId)).lines[0].group_id;
    // As if placed long ago: the payment, not the placing, starts the clock.
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.order.update({ where: { id: orderId }, data: { promisedOn: new Date('2000-01-03T00:00:00Z') } });
      await tx.jobAssignment.updateMany({ where: { groupId: group }, data: { dueOn: new Date('2000-01-01T00:00:00Z') } });
    });

    await pay(tenant, orderId);

    const row = await prisma.inTenant(tenant.id, (tx) => tx.order.findUniqueOrThrow({ where: { id: orderId } }));
    const promised = promisedDate(row.productionStartedAt!, WORKING_DAYS, DEFAULT_CALENDAR, tenant.timezone);
    expect((await staffView(tenant, orderId)).promised_on).toBe(promised);
    const job = await prisma.inTenant(tenant.id, (tx) => tx.jobAssignment.findFirstOrThrow({ where: { groupId: group, status: 'accepted' } }));
    const dueOn = job.dueOn!.toISOString().slice(0, 10);
    expect(dueOn > '2000-01-01').toBe(true);
    expect(dueOn <= promised).toBe(true);
  });

  it('makes the line in-house and tells staff when the held workshop was suspended before the payment', async () => {
    const tenant = await freshTenant();
    const orderId = await tenant.placeOrder();
    const group = (await staffView(tenant, orderId)).lines[0].group_id;
    await tenant.staff.post(`/partners/${tenant.metalworks.id}/suspend`).expect(200);

    await pay(tenant, orderId);

    const order = await staffView(tenant, orderId);
    expect(order.state).toBe('in_production');
    expect(order.lines[0].partner).toBeNull();
    const history = (await tenant.staff.get(`/partners/jobs/${group}`).expect(200)).body as { data: { status: string }[] };
    expect(history.data.map((row) => row.status)).toEqual(['withdrawn']);
    expect(await raised(tenant, 'order.partner_lost')).toBe(1);
    expect(await raised(tenant, 'partner.job.direct')).toBe(0);
  });

  it("shows staff an order's payments, checkouts and journals, and keeps customers out", async () => {
    const tenant = await freshTenant();
    const orderId = await tenant.placeOrder();
    await pay(tenant, orderId);

    const res = await tenant.staff.get(`/orders/${orderId}/payments`).expect(200);

    expectDocumented(orderPaymentsResponseSchema, res.body);
    const body = res.body as { payment: { state: string }; checkouts: { status: string }[]; journals: { kind: string }[] };
    expect(body.payment.state).toBe('paid');
    expect(body.checkouts.map((checkout) => checkout.status)).toEqual(['complete']);
    expect(body.journals.map((journal) => journal.kind).sort()).toEqual(['order_billed', 'payment_received', 'provider_fee']);
    await tenant.buyer.get(`/orders/${orderId}/payments`).expect(403);
  });
});
