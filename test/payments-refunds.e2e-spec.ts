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
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { LedgerService } from '../src/modules/payments/ledger.service';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { refundSuggestionResponseSchema } from '../src/modules/payments/payment-response';
import { measuredDesign } from './catalog-fixtures';
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
  lines: { position: number; total: string; group_id: string }[];
  payment: { state: string; paid: string; refunded: string };
}

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const NO_KEYS = { secretKey: '' };
const PAID_AFTER_CANCEL = 'Paid after the order was cancelled';
const d = (value: string) => new Prisma.Decimal(value);

/** The real jobs, with a tiny backoff so a retry happens within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'payments.event': { ...JOBS['payments.event'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

/**
 * Refunds (Payments plan, Task 10): cancelling a paid order refunds what staff decide, suggested from
 * the work a partner is owed for; a customer cancelling refunds everything left. Refunds never pass
 * what was paid, a payment arriving for a cancelled order is refunded in full, and every refund is
 * journalled once it succeeds.
 */
describe('payments: refunds', () => {
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
   * The priced cast part, published; `courier` at 9.90; tax at 19 %; the workspace's payment keys;
   * MetalWorks taking direct orders for the whole cast line; Anna's studio, paying first and allowed
   * to pick a workshop, with a buyer. A member may change orders but not refund.
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

    /** Anna's buyer orders `lines` lines at MetalWorks: the order waits for payment, holding the job. */
    const placeOrder = async (lines = 1) => {
      const quotes = [];
      for (let i = 0; i < lines; i += 1) {
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
        quotes.push({ quote_id: quote.id });
      }
      const placed = await buyer
        .post(`/portal/customers/${anna}/orders`, {
          lines: quotes,
          address: { name: 'Anna Studio', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
          shipping_method: 'courier',
        })
        .expect(201);
      return (placed.body as { id: string }).id;
    };

    return {
      id: tenant.id,
      staff,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      buyer,
      anna,
      metalworks,
      placeOrder,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const staffView = async (tenant: Tenant, orderId: string) => (await tenant.staff.get(`/orders/${orderId}`).expect(200)).body as StaffOrder;
  const event = (type: string, objectId: string) => ({ id: `evt_${newId().replaceAll('-', '')}`, type, objectId });
  /** The customer pays the order's open checkout at the provider, and the provider tells us. */
  const payByCard = async (tenant: Tenant, orderId: string) => {
    const checkout = await prisma.inTenant(tenant.id, (tx) => tx.orderPayment.findFirstOrThrow({ where: { orderId, status: 'open' } }));
    fake.completeCheckout(checkout.providerCheckoutId!);
    const sent = event('checkout.session.completed', checkout.providerCheckoutId!);
    await sendEvent(app, tenant.id, sent);
    return { providerCheckoutId: checkout.providerCheckoutId!, sent };
  };
  /** A paid order, in production at MetalWorks. */
  const paidOrder = async (tenant: Tenant, lines = 1) => {
    const orderId = await tenant.placeOrder(lines);
    await payByCard(tenant, orderId);
    return staffView(tenant, orderId);
  };
  const refunds = (tenant: Tenant, orderId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.refund.findMany({ where: { orderId }, orderBy: { id: 'asc' } }));
  /** The order's refunds, once none is pending any more. */
  const settled = (tenant: Tenant, orderId: string) =>
    waitFor(async () => {
      const rows = await refunds(tenant, orderId);
      return rows.length > 0 && rows.every((row) => row.status !== 'pending') ? rows : undefined;
    });
  const journals = (tenant: Tenant, orderId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.ledgerJournal.findMany({ where: { orderId }, include: { lines: true }, orderBy: { id: 'asc' } }));
  const balance = (tenant: Tenant, account: 'customer_receivable' | 'outside_stripe' | 'stripe_balance' | 'sales', orderId: string) =>
    prisma.inTenant(tenant.id, (tx) => app.get(LedgerService).balance(tx, account, { orderId }));
  const raised = (tenant: Tenant, eventKey: string, orderId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey, subjectId: orderId } }));
  const cancel = (tenant: Tenant, orderId: string, body: object, by = tenant.staff) => by.post(`/orders/${orderId}/cancel`, body);

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
    // The worker makes the refunds and applies the webhooks with its own provider instance, which sees what the app's saw.
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('refunds everything when the customer cancels a paid order before any work, and journals it', async () => {
    const tenant = await freshTenant();
    const order = await paidOrder(tenant);

    await tenant.buyer.post(`/portal/customers/${tenant.anna}/orders/${order.id}/cancel`, { reason: 'Changed my mind' }).expect(200);

    const [refund] = await settled(tenant, order.id);
    expect(refund).toMatchObject({ kind: 'provider', status: 'succeeded', reason: 'Changed my mind', providerRefundId: expect.any(String) });
    expect(refund.amount.toFixed(2)).toBe(order.total);
    expect((await fake.getRefund(NO_KEYS, refund.providerRefundId!)).status).toBe('succeeded');

    const posted = await journals(tenant, order.id);
    expect(posted.map((journal) => journal.kind)).toEqual(['order_billed', 'payment_received', 'provider_fee', 'refund', 'refund']);
    for (const journal of posted) {
      expect(journal.lines.reduce((sum, line) => sum.plus(line.amount), d('0')).toFixed(2)).toBe('0.00');
    }
    expect((await balance(tenant, 'customer_receivable', order.id)).toFixed(2)).toBe('0.00');
    expect((await balance(tenant, 'sales', order.id)).toFixed(2)).toBe('0.00');
    expect((await staffView(tenant, order.id)).payment).toMatchObject({ state: 'refunded', paid: order.total, refunded: order.total });
    await waitFor(async () => ((await raised(tenant, 'refund.made', order.id)) === 1 ? true : undefined));
  });

  it('suggests a refund from the work a partner is owed for, and refunds what staff decide', async () => {
    const tenant = await freshTenant();
    const order = await paidOrder(tenant);
    const group = order.lines[0].group_id;
    // MetalWorks has done its part, and is owed 30.00 for it.
    await tenant.staff.put(`/partners/jobs/${group}/owed`, { partner_id: tenant.metalworks, amount: '30.00', reason: 'Agreed price' }).expect(200);
    await prisma.inTenant(tenant.id, (tx) => tx.workOrder.updateMany({ where: { groupId: group }, data: { status: 'finished', currentStepId: null } }));

    const suggestion = await tenant.staff.get(`/orders/${order.id}/refund-suggestion`).expect(200);

    expectDocumented(refundSuggestionResponseSchema, suggestion.body);
    expect(suggestion.body).toEqual({ suggested: d(order.total).minus('30.00').toFixed(2), work_done: '30.00', paid_left: order.total });
    // The same for the order's only line named.
    expect((await tenant.staff.get(`/orders/${order.id}/refund-suggestion?lines=0`).expect(200)).body).toEqual(suggestion.body);
    await tenant.member.get(`/orders/${order.id}/refund-suggestion`).expect(403);

    const owed = [{ position: 0, amount: '30.00', reason: 'Agreed price' }];
    // A paid order is cancelled with a refund decided; a member may not refund.
    await cancel(tenant, order.id, { reason: 'Customer withdrew', partner_owed: owed }).expect(400);
    await cancel(tenant, order.id, { reason: 'Customer withdrew', partner_owed: owed, refund: { amount: '50.00' } }, tenant.member).expect(403);
    await cancel(tenant, order.id, { reason: 'Customer withdrew', partner_owed: owed, refund: { amount: '50.00' } }).expect(200);

    const [refund] = await settled(tenant, order.id);
    expect(refund).toMatchObject({ status: 'succeeded', reason: 'Customer withdrew' });
    expect(refund.amount.toFixed(2)).toBe('50.00');
    expect((await staffView(tenant, order.id)).payment).toMatchObject({ state: 'partly_refunded', refunded: '50.00' });
  });

  it('refunds no more than was paid: of two cancels at once, the one passing it is refused (Review Focus 4)', async () => {
    const tenant = await freshTenant();
    const order = await paidOrder(tenant, 2);
    // Each a good part of the total; together more than it.
    const each = d(order.total).mul('0.7').toDecimalPlaces(2).toFixed(2);

    const results = await Promise.all(
      [0, 1].map((position) => cancel(tenant, order.id, { reason: 'Customer withdrew', lines: [position], refund: { amount: each } })),
    );

    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    await settled(tenant, order.id);
    expect((await refunds(tenant, order.id)).map((row) => row.amount.toFixed(2))).toEqual([each]);
    // The line left can't be refunded past what is left either, and stays live.
    const left = d(order.total).minus(each);
    const live = (await staffView(tenant, order.id)).lines.find((line) => results[line.position].status === 409)!;
    await cancel(tenant, order.id, { reason: 'Customer withdrew', lines: [live.position], refund: { amount: left.plus('0.01').toFixed(2) } }).expect(409);
    expect(await refunds(tenant, order.id)).toHaveLength(1);
    await cancel(tenant, order.id, { reason: 'Customer withdrew', lines: [live.position], refund: { amount: left.toFixed(2) } }).expect(200);
    await settled(tenant, order.id);
    expect((await staffView(tenant, order.id)).payment).toMatchObject({ state: 'refunded', refunded: order.total });
  });

  it('refunds in full a payment arriving for an order already cancelled, once (Review Focus 1)', async () => {
    const tenant = await freshTenant();
    const orderId = await tenant.placeOrder();
    const checkout = await prisma.inTenant(tenant.id, (tx) => tx.orderPayment.findFirstOrThrow({ where: { orderId, status: 'open' } }));
    await tenant.buyer.post(`/portal/customers/${tenant.anna}/orders/${orderId}/cancel`, { reason: 'Changed my mind' }).expect(200);
    expect(await refunds(tenant, orderId)).toEqual([]);

    // The customer had the checkout open, and paid it anyway.
    fake.completeCheckout(checkout.providerCheckoutId!);
    await sendEvent(app, tenant.id, event('checkout.session.completed', checkout.providerCheckoutId!));

    const [refund] = await settled(tenant, orderId);
    const order = await staffView(tenant, orderId);
    expect(order).toMatchObject({ state: 'cancelled', payment: { state: 'refunded', paid: order.total, refunded: order.total } });
    expect(refund).toMatchObject({ status: 'succeeded', reason: PAID_AFTER_CANCEL });
    expect(refund.amount.toFixed(2)).toBe(order.total);
    expect((await journals(tenant, orderId)).map((journal) => journal.kind)).toEqual([
      'order_billed',
      'payment_received',
      'provider_fee',
      'refund',
      'refund',
    ]);
    await waitFor(async () => ((await raised(tenant, 'refund.made', orderId)) === 1 ? true : undefined));
    // Never started: the workshop never hears of the job.
    expect(await prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey: 'partner.job.direct' } }))).toBe(0);

    await sendEvent(app, tenant.id, event('checkout.session.completed', checkout.providerCheckoutId!));
    expect(await refunds(tenant, orderId)).toHaveLength(1);
    expect(await journals(tenant, orderId)).toHaveLength(5);
  });

  it('journals a refund the provider settles later, once, when it says so', async () => {
    const tenant = await freshTenant();
    const order = await paidOrder(tenant);
    fake.holdNextRefund();

    await cancel(tenant, order.id, { reason: 'Customer withdrew', refund: { amount: order.total } }).expect(200);

    const pending = await waitFor(async () => {
      const [row] = await refunds(tenant, order.id);
      return row?.providerRefundId ? row : undefined;
    });
    expect(pending.status).toBe('pending');
    expect((await journals(tenant, order.id)).filter((journal) => journal.kind === 'refund')).toEqual([]);
    expect((await staffView(tenant, order.id)).payment).toMatchObject({ state: 'paid', refunded: '0.00' });

    fake.settleRefund(pending.providerRefundId!, 'succeeded');
    await sendEvent(app, tenant.id, event('refund.updated', pending.providerRefundId!));
    await sendEvent(app, tenant.id, event('charge.refund.updated', pending.providerRefundId!));

    expect((await refunds(tenant, order.id))[0].status).toBe('succeeded');
    expect((await journals(tenant, order.id)).filter((journal) => journal.kind === 'refund')).toHaveLength(2);
    expect((await staffView(tenant, order.id)).payment).toMatchObject({ state: 'refunded', refunded: order.total });
    expect(await raised(tenant, 'refund.made', order.id)).toBe(1);
  });

  it('tells staff of a refund the provider refuses, and journals nothing', async () => {
    const tenant = await freshTenant();
    const order = await paidOrder(tenant);
    fake.holdNextRefund();
    await cancel(tenant, order.id, { reason: 'Customer withdrew', refund: { amount: order.total } }).expect(200);
    const pending = await waitFor(async () => {
      const [row] = await refunds(tenant, order.id);
      return row?.providerRefundId ? row : undefined;
    });

    fake.settleRefund(pending.providerRefundId!, 'failed');
    await sendEvent(app, tenant.id, event('refund.updated', pending.providerRefundId!));

    expect((await refunds(tenant, order.id))[0].status).toBe('failed');
    expect((await journals(tenant, order.id)).filter((journal) => journal.kind === 'refund')).toEqual([]);
    expect(await raised(tenant, 'refund.failed', order.id)).toBe(1);
    expect(await raised(tenant, 'refund.made', order.id)).toBe(0);
  });

  it('refunds an order paid by hand outside the provider, at once', async () => {
    const tenant = await freshTenant();
    const orderId = await tenant.placeOrder();
    const today = new Date().toISOString().slice(0, 10);
    const order = (await tenant.staff.post(`/orders/${orderId}/paid-by-hand`, { reference: 'Bank transfer', received_on: today }).expect(200))
      .body as StaffOrder;

    await cancel(tenant, orderId, { reason: 'Customer withdrew', refund: { amount: order.total } }).expect(200);

    const [refund] = await refunds(tenant, orderId);
    expect(refund).toMatchObject({ kind: 'outside', status: 'succeeded', providerRefundId: null });
    expect((await balance(tenant, 'outside_stripe', orderId)).toFixed(2)).toBe('0.00');
    expect((await balance(tenant, 'stripe_balance', orderId)).toFixed(2)).toBe('0.00');
    expect((await staffView(tenant, orderId)).payment).toMatchObject({ state: 'refunded', refunded: order.total });
  });
});
