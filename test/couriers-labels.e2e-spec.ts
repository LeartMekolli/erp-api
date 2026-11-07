import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { CourierEventsService } from '../src/modules/couriers/courier-events.service';
import { COURIER_PROVIDER } from '../src/modules/couriers/courier-provider';
import { signFakeCourierEvent } from '../src/modules/couriers/fake-courier-provider';
import type { FakeCourierProvider } from '../src/modules/couriers/fake-courier-provider';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { bulkShipResponseSchema, customerOrderResponseSchema, orderResponseSchema } from '../src/modules/orders/order-response';
import { OrderStatesService } from '../src/modules/orders/order-states.service';
import { webhookAckResponseSchema } from '../src/modules/payments/payment-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Label {
  url: string;
  carrier: string;
  service: string;
  tracking: string;
  tracking_status: string | null;
  cost: string;
}

interface Order {
  id: string;
  number: number;
  state: string;
  shipping: { courier: string | null; tracking: string | null; label: Label | null; delivered_at: string | null };
  lines: { group_id: string }[];
}

const ACCOUNT = {
  api_key: 'EZTKtest_secret_key_123',
  webhook_secret: 'whsec_courier_test',
  from_address: { name: 'Sol Studio', line1: 'Main street 2', city: 'Munich', postal_code: '80331', country: 'DE' },
};
const PARCEL = { weight_g: 1_200, length_cm: 20, width_cm: 15, height_cm: 10 };
const ADDRESS = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };

/**
 * Labels and tracking (Orders 3b plan, Task 4): shipping an order may buy its label from the workspace's
 * courier service while staff wait, once, outside any transaction; the courier's tracking webhook keeps the
 * shipment's state and marks the order delivered. Stored events are applied here with
 * `CourierEventsService.apply`, under a queue prefix no worker reads.
 */
describe('couriers: labels and tracking', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let events: CourierEventsService;
  let fake: FakeCourierProvider;
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

  /** The cast part, a live `live` (FakeCarrier standard) and a fixed `courier`, Luna Jewels on pay later with a viewer; the courier account unless `account` is false. */
  async function workspace(options: { account?: boolean } = {}) {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staffToken = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const staff = as(staffToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    if (options.account !== false) await staff.put('/couriers/account', ACCOUNT).expect(200);
    await staff
      .post('/orders/shipping-methods', { key: 'live', name: 'Tracked courier', live_rate: { carrier: 'FakeCarrier', service: 'standard' }, default_parcel: PARCEL })
      .expect(201);

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    await staff.put(`/customers/${luna}/payment-terms`, { terms: 'pay_later' }).expect(200);
    const viewerUser = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.user.update({ where: { id: viewerUser.id }, data: { kind: 'customer' } });
      await tx.organisationMembership.create({ data: { userId: viewerUser.id, organisationType: 'customer', organisationId: luna, role: 'viewer' } });
    });

    const quote = async () =>
      (
        (
          await staff
            .post('/pricing/quotes', {
              product_id: cast.productId,
              options: { material: 'silver_925', finish: 'polished' },
              size: { scale: '1.5' },
              quantity: 2,
              file_version_id: cast.versionId,
              customer_id: luna,
            })
            .expect(201)
        ).body as { quote: { id: string } }
      ).quote.id;
    /**
     * Placed and every piece finished directly: moving pieces through every step is Workflow's to test. The
     * order's states are then stored again, as a real move does, so a refused ship still reads `ready`.
     */
    const place = async (method = 'live', address: object = ADDRESS): Promise<Order> =>
      (await staff.post('/orders', { customer_id: luna, lines: [{ quote_id: await quote() }], address, shipping_method: method }).expect(201))
        .body as Order;
    const ready = async (method = 'live', address: object = ADDRESS): Promise<Order> => {
      const placed = await place(method, address);
      await prisma.inTenant(tenant.id, async (tx) => {
        await tx.workOrder.updateMany({ where: { groupId: { in: placed.lines.map((line) => line.group_id) } }, data: { status: 'finished', currentStepId: null } });
        await app.get(OrderStatesService).refresh(tx, [placed.id]);
      });
      return placed;
    };
    const ship = (id: string, body: object = { label: {} }) => staff.post(`/orders/${id}/ship`, body);
    const shipments = (orderId: string) => prisma.inTenant(tenant.id, (tx) => tx.shipment.findMany({ where: { orderId } }));
    const raised = (orderId: string, eventKey: string) =>
      prisma.inTenant(tenant.id, (tx) => tx.notification.findMany({ where: { subjectType: 'order', subjectId: orderId, eventKey } }));

    return {
      id: tenant.id,
      staff,
      staffAuth: `Bearer ${staffToken}`,
      viewer: as((await tokens.issueForUser(tenant.id, viewerUser.id)).accessToken),
      luna,
      place,
      ready,
      ship,
      shipments,
      raised,
    };
  }

  /** A tracker update as EasyPost sends it: only the parts `verifyEvent` reads. */
  const trackerBody = (id: string, tracking: string, status: string) =>
    JSON.stringify({ id, description: 'tracker.updated', result: { tracking_code: tracking, status } });

  const postRaw = (tenantId: string, body: string, signature?: string) => {
    const req = http().post(`/webhooks/couriers/${tenantId}`).set('Content-Type', 'application/json');
    return (signature === undefined ? req : req.set('X-Hmac-Signature', signature)).send(body);
  };

  /** Sends a signed tracker update and applies the event it stored. */
  async function track(tenantId: string, tracking: string, status: string, id = `evt_${randomUUID()}`) {
    const body = trackerBody(id, tracking, status);
    const response = await postRaw(tenantId, body, signFakeCourierEvent(Buffer.from(body), ACCOUNT.webhook_secret)).expect(200);
    expectDocumented(webhookAckResponseSchema, response.body);
    const stored = await prisma.inTenant(tenantId, (tx) => tx.courierEvent.findFirstOrThrow({ where: { providerEventId: id } }));
    await events.apply(tenantId, stored.id);
    return id;
  }

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    events = app.get(CourierEventsService);
    fake = app.get<FakeCourierProvider>(COURIER_PROVIDER);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('ships an order with a bought label, and the courier marks it delivered (Done when 6)', async () => {
    const w = await workspace();
    const placed = await w.ready();

    const shipped = await w.ship(placed.id).expect(200);
    expectDocumented(orderResponseSchema, shipped.body);
    const order = shipped.body as Order;
    expect(order.state).toBe('shipped');
    const label = order.shipping.label!;
    expect(label).toMatchObject({ carrier: 'FakeCarrier', service: 'standard', tracking: expect.stringMatching(/^FAKE\d{6}$/), cost: '6.90' });
    expect(label.url).toMatch(/^https:\/\/labels\.example\.test\//);
    expect(order.shipping).toMatchObject({ courier: 'FakeCarrier', tracking: label.tracking });
    const [notice] = await w.raised(placed.id, 'order.shipped');
    expect(notice.payload).toMatchObject({ courier: 'FakeCarrier', tracking: label.tracking });

    await track(w.id, label.tracking, 'in_transit');
    expect(((await w.staff.get(`/orders/${placed.id}`).expect(200)).body as Order).shipping.label!.tracking_status).toBe('in_transit');

    await track(w.id, label.tracking, 'delivered');
    const delivered = await w.staff.get(`/orders/${placed.id}`).expect(200);
    expectDocumented(orderResponseSchema, delivered.body);
    expect(delivered.body).toMatchObject({ state: 'delivered', shipping: { delivered_at: expect.any(String), label: { tracking_status: 'delivered' } } });
    expect(await w.raised(placed.id, 'order.delivered')).toHaveLength(1);
    const audited = await prisma.inTenant(w.id, (tx) => tx.auditEntry.findMany({ where: { action: 'order.changed', subjectId: placed.id } }));
    expect(audited.at(-1)!.actorType).toBe('system');

    // The customer sees how the parcel is doing, never the label's cost.
    const seen = await w.viewer.get(`/portal/customers/${w.luna}/orders/${placed.id}`).expect(200);
    expectDocumented(customerOrderResponseSchema, seen.body);
    expect(seen.body).toMatchObject({ state: 'delivered', shipping: { tracking: label.tracking, tracking_status: 'delivered' } });
    expect((seen.body as { shipping: object }).shipping).not.toHaveProperty('label');
  });

  it('buys one label when two staff ship at once (Review Focus 1)', async () => {
    const w = await workspace();
    const placed = await w.ready();
    const boughtBefore = fake.bought.length;

    const both = await Promise.all([w.ship(placed.id), w.ship(placed.id)]);
    const statuses = both.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    // The loser finds the label being bought, or the order already shipped.
    expect(['label_in_progress', 'order_already_shipped']).toContain(both.find((response) => response.status === 409)!.body.code);
    expect(fake.bought.length - boughtBefore).toBe(1);
    expect(await w.shipments(placed.id)).toEqual([expect.objectContaining({ status: 'bought' })]);
    expect(await w.raised(placed.id, 'order.shipped')).toHaveLength(1);
    // Pressed again once shipped: still one label.
    expect((await w.ship(placed.id).expect(409)).body.code).toBe('order_already_shipped');
    expect(fake.bought.length - boughtBefore).toBe(1);
  });

  it("buys once when the courier's answer to a purchase is lost, and ships with that label on a retry (Review Focus 1)", async () => {
    const w = await workspace();
    const placed = await w.ready();
    const boughtBefore = fake.bought.length;

    // Bought at the service, but the answer timed out: staff can't tell, and try again.
    fake.loseNextAnswer();
    await w.ship(placed.id).expect(503);
    expect(fake.bought.length - boughtBefore).toBe(1);

    const retried = (await w.ship(placed.id).expect(200)).body as Order;
    expect(fake.bought.length - boughtBefore).toBe(1);
    expect(retried.shipping.label!.tracking).toBe(fake.bought.at(-1)!.tracking);
    expect(await w.shipments(placed.id)).toEqual([expect.objectContaining({ status: 'bought', error: null })]);
  });

  it('keeps the order ready when the courier refuses, and buys once on a retry (Review Focus 2)', async () => {
    const w = await workspace();
    const placed = await w.ready('live', { ...ADDRESS, line1: 'FAIL' });
    const boughtBefore = fake.bought.length;

    const refused = await w.ship(placed.id).expect(503);
    expect((refused.body as { detail: string }).detail).toBe('The address was refused');
    const failed = ((await w.staff.get(`/orders/${placed.id}`).expect(200)).body as Order);
    expect(failed).toMatchObject({ state: 'ready', shipping: { courier: null, tracking: null, label: null } });
    expect(await w.shipments(placed.id)).toEqual([expect.objectContaining({ status: 'failed', error: 'The address was refused', tracking: null })]);

    // No route edits an order's address yet; staff correcting it is written here.
    await prisma.inTenant(w.id, (tx) => tx.order.update({ where: { id: placed.id }, data: { address: ADDRESS } }));
    const [failedRow] = await w.shipments(placed.id);
    const retried = (await w.ship(placed.id).expect(200)).body as Order;
    expect(retried.state).toBe('shipped');
    expect(await w.shipments(placed.id)).toEqual([expect.objectContaining({ id: failedRow.id, status: 'bought', error: null })]);
    expect(fake.bought.length - boughtBefore).toBe(1);

    // Shipping without a label still works, for a live method too.
    const plain = await w.ready();
    const shipped = (await w.ship(plain.id, { courier: 'DHL', tracking: 'JD0001' }).expect(200)).body as Order;
    expect(shipped.shipping).toMatchObject({ courier: 'DHL', tracking: 'JD0001', label: null });
    expect(await w.shipments(plain.id)).toEqual([]);
  });

  it('refuses a label without a parcel, a service or a courier account', async () => {
    const w = await workspace();
    // A fixed method names no service or parcel: both must be given.
    const fixed = await w.ready('courier');
    await w.ship(fixed.id).expect(400);
    await w.ship(fixed.id, { label: { parcel: PARCEL } }).expect(400);
    await w.ship(fixed.id, { label: { parcel: { ...PARCEL, weight_g: 0 }, carrier: 'FakeCarrier', service: 'express' } }).expect(400);
    // 9.90 and 2.00 for each of the 2 started kilos.
    const shipped = (await w.ship(fixed.id, { label: { parcel: PARCEL, carrier: 'FakeCarrier', service: 'express' } }).expect(200)).body as Order;
    expect(shipped.shipping.label).toMatchObject({ service: 'express', cost: '13.90' });

    const none = await workspace({ account: false });
    const placed = await none.ready('courier');
    const missing = await none.ship(placed.id, { label: { parcel: PARCEL, carrier: 'FakeCarrier', service: 'standard' } }).expect(409);
    expect(missing.body).toMatchObject({ code: 'courier_account_missing', detail: 'No courier service is set up for this workspace' });
    expect(((await none.staff.get(`/orders/${placed.id}`).expect(200)).body as Order).state).toBe('ready');
  });

  it('applies a tracking event once, ignores unknown tracking, and leaves a delivered order alone (Review Focus 3)', async () => {
    const w = await workspace();
    const placed = await w.ready();
    const { tracking } = ((await w.ship(placed.id).expect(200)).body as Order).shipping.label!;

    // The same event delivered twice is stored once.
    const id = await track(w.id, tracking, 'delivered');
    await track(w.id, tracking, 'delivered', id);
    expect(await prisma.inTenant(w.id, (tx) => tx.courierEvent.count())).toBe(1);
    expect(await w.raised(placed.id, 'order.delivered')).toHaveLength(1);

    // A second delivered event, as couriers send, changes nothing more.
    await track(w.id, tracking, 'delivered');
    expect(await w.raised(placed.id, 'order.delivered')).toHaveLength(1);
    const [shipment] = await w.shipments(placed.id);
    expect(shipment.deliveredAt).not.toBeNull();

    // An unknown tracking number is applied with no effect.
    const unknown = await track(w.id, 'NOSUCH000', 'delivered');
    expect(await prisma.inTenant(w.id, (tx) => tx.courierEvent.findFirstOrThrow({ where: { providerEventId: unknown } }))).toMatchObject({
      appliedAt: expect.any(Date),
    });

    // Staff marked it delivered before the courier did: left alone, and the customer is told once.
    const early = await w.ready();
    const earlyLabel = ((await w.ship(early.id).expect(200)).body as Order).shipping.label!;
    await w.staff.post(`/orders/${early.id}/deliver`).expect(200);
    await track(w.id, earlyLabel.tracking, 'delivered');
    expect(await w.raised(early.id, 'order.delivered')).toHaveLength(1);
    expect(((await w.staff.get(`/orders/${early.id}`).expect(200)).body as Order).shipping.label!.tracking_status).toBe('delivered');

    // Not a tracker update: answered and left alone.
    const other = JSON.stringify({ id: `evt_${randomUUID()}`, description: 'batch.updated', result: {} });
    await postRaw(w.id, other, signFakeCourierEvent(Buffer.from(other), ACCOUNT.webhook_secret)).expect(200);
  });

  it('refuses a webhook with a bad signature, without an account, or for an unknown workspace', async () => {
    const w = await workspace();
    const body = trackerBody(`evt_${randomUUID()}`, 'FAKE000001', 'delivered');
    await postRaw(w.id, body, signFakeCourierEvent(Buffer.from(body), 'not the secret')).expect(400);
    await postRaw(w.id, body).expect(400);
    expect(await prisma.inTenant(w.id, (tx) => tx.courierEvent.count())).toBe(0);

    const none = await workspace({ account: false });
    await postRaw(none.id, body, signFakeCourierEvent(Buffer.from(body), ACCOUNT.webhook_secret)).expect(400);
    await postRaw(randomUUID(), body, signFakeCourierEvent(Buffer.from(body), ACCOUNT.webhook_secret)).expect(404);
    await postRaw('not-a-workspace', body).expect(404);
  });

  describe('shipping several orders at once', () => {
    type Workspace = Awaited<ReturnType<typeof workspace>>;
    type Result =
      | { order_id: string; result: 'shipped'; order: Order }
      | { order_id: string; result: 'failed'; error: { status: number; code: string | null; detail: string } };

    const shipMany = (w: Workspace, orders: object[], key?: string) => {
      const req = http().post('/orders/ship');
      return (key ? req.set('Idempotency-Key', key) : req).set('Authorization', w.staffAuth).send({ orders });
    };
    /** `POST /orders/ship` answered 200, checked against its documented shape. */
    const shipped = async (w: Workspace, orders: object[], key?: string) => {
      const response = await shipMany(w, orders, key).expect(200);
      expectDocumented(bulkShipResponseSchema, response.body);
      return (response.body as { results: Result[] }).results;
    };
    const stateOf = async (w: Workspace, id: string) => ((await w.staff.get(`/orders/${id}`).expect(200)).body as Order).state;

    it("ships each order as the single route does, in the request's order", async () => {
      const w = await workspace();
      const label = await w.ready();
      const byHand = await w.ready();
      const making = await w.place();
      const boughtBefore = fake.bought.length;

      const results = await shipped(w, [
        { order_id: label.id, label: {} },
        { order_id: byHand.id, courier: 'DHL', tracking: 'JD0001' },
        { order_id: making.id },
      ]);
      expect(results.map((one) => [one.order_id, one.result])).toEqual([
        [label.id, 'shipped'],
        [byHand.id, 'shipped'],
        [making.id, 'failed'],
      ]);
      const [first, second, third] = results;
      expect(first).toMatchObject({ order: { state: 'shipped', shipping: { courier: 'FakeCarrier', label: { tracking: expect.stringMatching(/^FAKE/) } } } });
      expect(second).toMatchObject({ order: { state: 'shipped', shipping: { courier: 'DHL', tracking: 'JD0001', label: null } } });
      expect(third).toMatchObject({ error: { status: 409, code: 'order_not_ready' } });
      expect(fake.bought.length - boughtBefore).toBe(1);
      expect(await w.raised(label.id, 'order.shipped')).toHaveLength(1);
      expect(await w.raised(byHand.id, 'order.shipped')).toHaveLength(1);
      expect(await w.raised(making.id, 'order.shipped')).toHaveLength(0);
    });

    it('keeps going when one order fails', async () => {
      const w = await workspace();
      const elsewhere = await workspace();
      const refused = await w.ready('live', { ...ADDRESS, line1: 'FAIL' });
      const foreign = await elsewhere.ready();
      const missing = randomUUID();
      const byHand = await w.ready();

      const results = await shipped(w, [
        { order_id: refused.id, label: {} },
        { order_id: foreign.id },
        { order_id: missing },
        { order_id: byHand.id },
      ]);
      expect(results).toEqual([
        { order_id: refused.id, result: 'failed', error: { status: 503, code: null, detail: 'The address was refused' } },
        { order_id: foreign.id, result: 'failed', error: expect.objectContaining({ status: 404, code: null }) },
        { order_id: missing, result: 'failed', error: expect.objectContaining({ status: 404, code: null }) },
        expect.objectContaining({ order_id: byHand.id, result: 'shipped' }),
      ]);
      expect(await stateOf(w, refused.id)).toBe('ready');
      expect(await stateOf(elsewhere, foreign.id)).toBe('ready');

      // An error nobody wrote is a 500 with the generic detail, and the order stays ready.
      const broken = await w.ready();
      jest.spyOn(fake, 'buy').mockRejectedValueOnce(new Error('boom'));
      expect(await shipped(w, [{ order_id: broken.id, label: {} }])).toEqual([
        { order_id: broken.id, result: 'failed', error: { status: 500, code: null, detail: 'An unexpected error occurred.' } },
      ]);
      expect(await stateOf(w, broken.id)).toBe('ready');
    });

    it("answers each order's conflict code", async () => {
      const none = await workspace({ account: false });
      const noAccount = await none.ready('courier');
      // A live rate needs the courier account to price it: without one, the fixed method.
      const done = await none.ready('courier');
      await none.ship(done.id, {}).expect(200);

      const results = await shipped(none, [
        { order_id: noAccount.id, label: { parcel: PARCEL, carrier: 'FakeCarrier', service: 'standard' } },
        { order_id: done.id },
      ]);
      expect(results).toEqual([
        { order_id: noAccount.id, result: 'failed', error: expect.objectContaining({ status: 409, code: 'courier_account_missing' }) },
        { order_id: done.id, result: 'failed', error: expect.objectContaining({ status: 409, code: 'order_already_shipped' }) },
      ]);
    });

    it('ships 7 orders with labels, 5 at a time, one label each', async () => {
      const w = await workspace();
      const orders: Order[] = [];
      for (let i = 0; i < 7; i += 1) orders.push(await w.ready());
      const buy = fake.buy.bind(fake);
      let pending = 0;
      let highest = 0;
      // Purchases wait at a gate that opens once 5 are waiting: a 6th starting early would be seen, whatever
      // the timing. Should fewer than 5 ever arrive, it opens after 5 seconds and `highest` says so.
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const fallback = setTimeout(() => open(), 5_000);
      jest.spyOn(fake, 'buy').mockImplementation(async (...args) => {
        pending += 1;
        highest = Math.max(highest, pending);
        if (pending === 5) open();
        try {
          await gate;
          return await buy(...args);
        } finally {
          pending -= 1;
        }
      });

      const results = await shipped(
        w,
        orders.map((order) => ({ order_id: order.id, label: {} })),
      );
      clearTimeout(fallback);
      expect(results.map((one) => one.result)).toEqual(Array(7).fill('shipped'));
      expect(highest).toBe(5);
      for (const order of orders) expect(await w.shipments(order.id)).toEqual([expect.objectContaining({ status: 'bought' })]);
    });

    it('refuses a bad batch whole, and ships nothing', async () => {
      const w = await workspace();
      const a = await w.ready();
      const b = await w.ready();
      const many = [{ order_id: a.id }, ...Array.from({ length: 25 }, () => ({ order_id: randomUUID() }))];

      for (const orders of [
        [],
        many,
        [{ order_id: a.id }, { order_id: a.id }],
        [{ order_id: a.id }, { order_id: b.id, label: {}, courier: 'DHL' }],
        [{ order_id: a.id }, { order_id: 'abc' }],
      ]) {
        await shipMany(w, orders).expect(400);
      }
      expect(await stateOf(w, a.id)).toBe('ready');
      expect(await stateOf(w, b.id)).toBe('ready');
    });

    it('replays the first answer for the same key, failed entries included', async () => {
      const w = await workspace();
      const good = await w.ready();
      const refused = await w.ready('live', { ...ADDRESS, line1: 'FAIL' });
      const orders = [
        { order_id: good.id, label: {} },
        { order_id: refused.id, label: {} },
      ];
      const key = `bulk-${randomUUID()}`;

      const first = await shipped(w, orders, key);
      expect(first.map((one) => one.result)).toEqual(['shipped', 'failed']);
      const boughtAfterFirst = fake.bought.length;
      expect(await shipped(w, orders, key)).toEqual(first);
      expect(fake.bought.length).toBe(boughtAfterFirst);
    });

    it('lets only those who may ship', async () => {
      const w = await workspace();
      const placed = await w.ready();
      const member = await createTestUser(prisma, w.id, { roles: ['member'] });
      await http()
        .post('/orders/ship')
        .set('Authorization', `Bearer ${(await tokens.issueForUser(w.id, member.id)).accessToken}`)
        .send({ orders: [{ order_id: placed.id }] })
        .expect(403);
      expect(await stateOf(w, placed.id)).toBe('ready');
    });
  });
});
