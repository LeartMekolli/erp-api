import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { customerOrderResponseSchema, orderResponseSchema } from '../src/modules/orders/order-response';
import { EligibilityService } from '../src/modules/partners/eligibility.service';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { payLinkResponseSchema } from '../src/modules/payments/payment-response';
import { UnpaidOrdersHandler } from '../src/modules/payments/unpaid-orders.handler';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Line {
  position: number;
  total: string;
  group_id: string;
}
interface StaffOrder {
  id: string;
  state: string;
  lines: Line[];
  total: string;
  payment: { terms: string; state: string; pay_by: string | null; pay_url: string | null };
}
interface CustomerOrder {
  id: string;
  state: string;
  payment: { state: string; pay_by: string | null; pay_url: string | null };
}

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const NO_KEYS = { secretKey: '' };
const WAITING = 'The order is waiting for payment';
const d = (value: string) => new Prisma.Decimal(value);

/**
 * Pay-first orders wait for payment (Payments plan, Task 5): the order and its workshop's job exist,
 * so the capacity is held, but nothing is made, offered or shown to the workshop until it is paid. The
 * customer pays through a checkout for what is still live; a waiting order not paid in time is cancelled.
 */
describe('payments: orders waiting for payment', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakePaymentProvider;
  const createdTenants: string[] = [];
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
   * MetalWorks, able to make the whole cast line and taking direct orders, with a member; Luna Jewels,
   * paying first (no terms set) and allowed to pick a workshop, with a buyer.
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

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    await staff.patch(`/customers/${luna}`, { may_pick_partner: true }).expect(200);
    const design = (await measuredDesign(prisma, tenant.id, owner.id, { customerId: luna })).versionId;
    const buyer = await person(tenant.id, 'customer', luna, 'buyer');

    const configuration = (extra: object = {}) => ({
      product_id: cast.productId,
      options: { material: 'silver_925', finish: 'polished' },
      size: { scale: '1.5' },
      quantity: 10,
      ...extra,
    });
    const staffQuote = async (quantity = 10) =>
      ((await staff.post('/pricing/quotes', { ...configuration({ quantity, file_version_id: cast.versionId }), customer_id: luna }).expect(201))
        .body as { quote: { id: string } }).quote;
    const pickedQuote = async () =>
      ((await buyer.post(`/portal/customers/${luna}/quotes`, configuration({ file_version_id: design, partner_id: metalworks })).expect(201))
        .body as { quote: { id: string } }).quote;

    return {
      id: tenant.id,
      staff,
      buyer,
      luna,
      metalworks: { id: metalworks, person: await person(tenant.id, 'partner', metalworks, 'member') },
      staffQuote,
      pickedQuote,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
  /** Luna's buyer orders at the workshop it picked. */
  const customerOrder = async (tenant: Tenant) => {
    const quote = await tenant.pickedQuote();
    const res = await tenant.buyer
      .post(`/portal/customers/${tenant.luna}/orders`, { lines: [{ quote_id: quote.id }], address, shipping_method: 'courier' })
      .expect(201);
    return res;
  };
  /** Staff order for Luna at the workspace's own prices, one line per quantity, no workshop. */
  const staffOrder = async (tenant: Tenant, quantities: number[]) => {
    const quoteIds = [];
    for (const quantity of quantities) quoteIds.push((await tenant.staffQuote(quantity)).id);
    return (await tenant.staff
      .post('/orders', { customer_id: tenant.luna, lines: quoteIds.map((quote_id) => ({ quote_id })), address, shipping_method: 'courier' })
      .expect(201)).body as StaffOrder;
  };
  const checkouts = (tenant: Tenant, orderId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.orderPayment.findMany({ where: { orderId }, orderBy: { id: 'asc' } }));
  /** The checkout as the provider has it; every row the tests read has had its provider id set. */
  const atFake = (checkoutId: string | null) => {
    if (!checkoutId) throw new Error('The checkout never reached the provider');
    return fake.getCheckout(NO_KEYS, checkoutId);
  };
  const raised = (tenant: Tenant, eventKey: string, subjectId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey, subjectId } }));
  /** MetalWorks's load across its step types. */
  const metalworksLoad = (tenant: Tenant) =>
    prisma.inTenant(tenant.id, async (tx) => {
      const loads = (await app.get(EligibilityService).loads(tx, [tenant.metalworks.id])).get(tenant.metalworks.id);
      return [...(loads?.values() ?? [])].reduce((sum, count) => sum + count, 0);
    });
  const runUnpaidCancel = () => app.get(UnpaidOrdersHandler).handle();
  const pastPayBy = (tenant: Tenant, orderId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.order.update({ where: { id: orderId }, data: { payBy: new Date(Date.now() - 60_000) } }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    fake = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it("holds a pay-first order and its workshop's job until it is paid, with a link to pay the total", async () => {
    const tenant = await freshTenant();

    const placed = await customerOrder(tenant);

    expectDocumented(customerOrderResponseSchema, placed.body);
    const body = placed.body as CustomerOrder;
    expect(body).toMatchObject({ state: 'awaiting_payment', payment: { state: 'awaiting_payment' } });
    expect(body.payment.pay_url).toEqual(expect.any(String));
    expect(body.payment.pay_by).toEqual(expect.any(String));

    const staffView = (await tenant.staff.get(`/orders/${body.id}`).expect(200)).body as StaffOrder;
    expectDocumented(orderResponseSchema, staffView);
    expect(staffView.payment).toMatchObject({ terms: 'pay_first', state: 'awaiting_payment', pay_url: body.payment.pay_url });

    // One open checkout, for the order's total, at the provider.
    const [checkout] = await checkouts(tenant, body.id);
    expect(checkout).toMatchObject({ status: 'open', url: body.payment.pay_url });
    expect(checkout.amount.toFixed(2)).toBe(staffView.total);
    expect((await atFake(checkout.providerCheckoutId)).amount.toFixed(2)).toBe(staffView.total);

    // The workshop's job holds its capacity, but the workshop doesn't see it or hear of it yet.
    expect(await metalworksLoad(tenant)).toBeGreaterThan(0);
    const group = staffView.lines[0].group_id;
    const listed = await tenant.metalworks.person.get(`/partner-portal/partners/${tenant.metalworks.id}/jobs`).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(group);
    await tenant.metalworks.person.get(`/partner-portal/partners/${tenant.metalworks.id}/jobs/${group}`).expect(404);
    await tenant.metalworks.person.get(`/partner-portal/partners/${tenant.metalworks.id}/jobs/${group}/design`).expect(404);
    // The direct job's notice names its hand-over, so none at all is the check.
    expect(await prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey: 'partner.job.direct' } }))).toBe(0);
    expect(await raised(tenant, 'payment.requested', body.id)).toBe(1);

    // Nothing of it is made.
    const pieces = ((await tenant.staff.get(`/workflow/work-orders?group_id=${group}&limit=100`).expect(200)).body as { data: { id: string }[] })
      .data.map((piece) => piece.id);
    const moved = await tenant.staff.post('/workflow/moves', { work_order_ids: pieces, at_step: 'print_pattern', kind: 'pass' }).expect(409);
    expect((moved.body as { detail: string }).detail).toContain(WAITING);
  });

  it('refuses offering or moving a line of a waiting order to a workshop', async () => {
    const tenant = await freshTenant();
    const order = await staffOrder(tenant, [10]);
    expect(order.payment.state).toBe('awaiting_payment');

    const offered = await tenant.staff.post(`/partners/jobs/${order.lines[0].group_id}/offer`, { partner_id: tenant.metalworks.id }).expect(409);
    expect((offered.body as { detail: string }).detail).toContain(WAITING);
    const reassigned = await tenant.staff
      .post(`/partners/jobs/${order.lines[0].group_id}/reassign`, { partner_id: tenant.metalworks.id })
      .expect(409);
    expect((reassigned.body as { detail: string }).detail).toContain(WAITING);
  });

  it('gives a new pay link on request and expires the one before; a pay-later order has none', async () => {
    const tenant = await freshTenant();
    const placed = (await customerOrder(tenant)).body as CustomerOrder;
    const [first] = await checkouts(tenant, placed.id);

    const res = await tenant.buyer.post(`/portal/customers/${tenant.luna}/orders/${placed.id}/pay`).expect(200);

    expectDocumented(payLinkResponseSchema, res.body);
    const [old, current] = await checkouts(tenant, placed.id);
    expect(old.id).toBe(first.id);
    expect(old.status).toBe('expired');
    expect((await atFake(old.providerCheckoutId)).status).toBe('expired');
    expect(current).toMatchObject({ status: 'open', url: (res.body as { url: string }).url });

    // Staff can hand out a link too.
    const staffLink = await tenant.staff.post(`/orders/${placed.id}/pay-link`).expect(200);
    expectDocumented(payLinkResponseSchema, staffLink.body);

    await tenant.staff.put(`/customers/${tenant.luna}/payment-terms`, { terms: 'pay_later' }).expect(200);
    const later = await staffOrder(tenant, [10]);
    expect(later.payment).toMatchObject({ terms: 'pay_later', state: 'not_billed', pay_url: null });
    await tenant.staff.post(`/orders/${later.id}/pay-link`).expect(409);
    await tenant.buyer.post(`/portal/customers/${tenant.luna}/orders/${later.id}/pay`).expect(409);
  });

  it('asks for the new, lower amount once a line is cancelled while the order waits', async () => {
    const tenant = await freshTenant();
    const order = await staffOrder(tenant, [10, 2]);
    const [first] = await checkouts(tenant, order.id);

    await tenant.staff.post(`/orders/${order.id}/cancel`, { reason: 'Customer changed their mind', lines: [1] }).expect(200);

    // The checkout for the old amount can't be paid any more.
    const [old] = await checkouts(tenant, order.id);
    expect(old.id).toBe(first.id);
    expect(old.status).toBe('expired');
    expect((await atFake(old.providerCheckoutId)).status).toBe('expired');

    await tenant.buyer.post(`/portal/customers/${tenant.luna}/orders/${order.id}/pay`).expect(200);
    const current = (await checkouts(tenant, order.id)).at(-1)!;
    // Line 0 and shipping, with 19 % tax on both, rounded once.
    const net = d(order.lines[0].total).plus('9.90');
    const expected = net.plus(net.times('0.19').toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP));
    expect(current.status).toBe('open');
    expect(current.amount.toFixed(2)).toBe(expected.toFixed(2));
    expect((await atFake(current.providerCheckoutId)).amount.toFixed(2)).toBe(expected.toFixed(2));
  });

  it('cancels an order not paid in time, frees its workshop and tells the customer, and leaves one in time', async () => {
    const tenant = await freshTenant();
    const late = (await customerOrder(tenant)).body as CustomerOrder;
    const inTime = await staffOrder(tenant, [10]);
    await pastPayBy(tenant, late.id);
    const [checkout] = await checkouts(tenant, late.id);

    await runUnpaidCancel();

    const row = await prisma.inTenant(tenant.id, (tx) => tx.order.findUniqueOrThrow({ where: { id: late.id } }));
    expect(row.cancelledAt).toBeInstanceOf(Date);
    expect(row.cancelReason).toBe('Not paid in time');
    expect((await tenant.staff.get(`/orders/${late.id}`).expect(200)).body).toMatchObject({
      state: 'cancelled',
      payment: { state: 'none' },
    });
    expect((await checkouts(tenant, late.id))[0].status).toBe('expired');
    expect((await atFake(checkout.providerCheckoutId)).status).toBe('expired');
    expect(await metalworksLoad(tenant)).toBe(0);
    expect(await raised(tenant, 'order.unpaid_cancelled', late.id)).toBe(1);

    expect((await tenant.staff.get(`/orders/${inTime.id}`).expect(200)).body).toMatchObject({ state: 'awaiting_payment' });

    // A second run finds nothing more to do.
    await runUnpaidCancel();
    expect(await raised(tenant, 'order.unpaid_cancelled', late.id)).toBe(1);
  });

  it('expires the checkout when the customer cancels a waiting order', async () => {
    const tenant = await freshTenant();
    const placed = (await customerOrder(tenant)).body as CustomerOrder;
    const [checkout] = await checkouts(tenant, placed.id);

    await tenant.buyer.post(`/portal/customers/${tenant.luna}/orders/${placed.id}/cancel`, { reason: 'Ordered by mistake' }).expect(200);

    expect((await tenant.staff.get(`/orders/${placed.id}`).expect(200)).body).toMatchObject({ state: 'cancelled' });
    expect((await checkouts(tenant, placed.id))[0].status).toBe('expired');
    expect((await atFake(checkout.providerCheckoutId)).status).toBe('expired');
    await tenant.buyer.post(`/portal/customers/${tenant.luna}/orders/${placed.id}/pay`).expect(409);
  });
});
