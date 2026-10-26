import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { resolveAudience } from '../src/modules/notifications/audience';
import { customerOrderResponseSchema, orderResponseSchema } from '../src/modules/orders/order-response';
import { SettingsService } from '../src/modules/settings/settings.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Order {
  id: string;
  number: number;
  state: string;
  shipping: { courier: string | null; tracking: string | null; shipped_at: string | null; delivered_at: string | null };
  lines: { group_id: string }[];
}

/**
 * Shipping and delivering an order, and who hears of it (Orders spec, goals 9 and 16; plan Task 8):
 * staff ship a ready order, with its courier and tracking, then mark it delivered. The customer's
 * people are told when it is placed, shipped, delivered and cancelled by staff; staff who read
 * orders, of each new one.
 */
describe('orders: shipping and notifications', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let settings: SettingsService;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none, so silver is at its fallback.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  /** A customer person written straight to the database, with a membership in a customer. */
  async function person(tenantId: string, customerId: string, role: string, status = 'active') {
    const user = await createTestUser(prisma, tenantId, { roles: [], status });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind: 'customer' } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'customer', organisationId: customerId, role } });
    });
    return { email: user.email, client: as((await tokens.issueForUser(tenantId, user.id)).accessToken) };
  }

  /** The priced cast part, published; `courier`; Luna Jewels with a buyer, a viewer and a deactivated person; Sol with a buyer. */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const sol = ((await staff.post('/customers', { name: 'Sol Studio' }).expect(201)).body as { id: string }).id;
    const buyer = await person(tenant.id, luna, 'buyer');
    const viewer = await person(tenant.id, luna, 'viewer');
    await person(tenant.id, luna, 'buyer', 'deactivated');
    await person(tenant.id, sol, 'buyer');

    const quote = async () =>
      ((
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
      ).body as { quote: { id: string } }).quote.id;

    return {
      id: tenant.id,
      staff,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      staffEmails: [owner.email, member.email],
      buyer,
      viewer,
      luna,
      quote,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
  const placeOrder = async (tenant: Tenant) =>
    (
      await tenant.staff
        .post('/orders', { customer_id: tenant.luna, lines: [{ quote_id: await tenant.quote() }], address, shipping_method: 'courier' })
        .expect(201)
    ).body as Order;
  /** Every piece finished directly: moving pieces through every step is Workflow's to test. */
  const finish = (tenant: Tenant, order: Order) =>
    prisma.inTenant(tenant.id, (tx) =>
      tx.workOrder.updateMany({ where: { groupId: { in: order.lines.map((line) => line.group_id) } }, data: { status: 'finished', currentStepId: null } }),
    );
  const ship = (tenant: Tenant, id: string, body: object = {}, by = tenant.staff) => by.post(`/orders/${id}/ship`, body);
  const deliver = (tenant: Tenant, id: string, by = tenant.staff) => by.post(`/orders/${id}/deliver`);
  /** The notifications raised about an order, sorted by event: two raised in one millisecond have no order. */
  const raised = (tenant: Tenant, orderId: string) =>
    prisma.inTenant(tenant.id, async (tx) =>
      (await tx.notification.findMany({ where: { subjectType: 'order', subjectId: orderId } }))
        .map((row) => ({ event: row.eventKey, payload: row.payload }))
        .sort((a, b) => a.event.localeCompare(b.event)),
    );
  /** Who a raised notification reaches, by email. */
  const reached = (tenant: Tenant, orderId: string, eventKey: string) =>
    prisma.inTenant(tenant.id, async (tx) => {
      const targets = await resolveAudience(tx, { tenantId: tenant.id, eventKey, subjectType: 'order', subjectId: orderId }, settings);
      return targets.map((target) => target.email).sort();
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    settings = moduleRef.get(SettingsService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('ships a ready order with its courier and tracking, then delivers it', async () => {
    const tenant = await freshTenant();
    const placed = await placeOrder(tenant);

    // Not before every piece is made, and not delivered before it ships.
    await ship(tenant, placed.id, { courier: 'DHL', tracking: 'JD0001' }).expect(409);
    await finish(tenant, placed);
    await deliver(tenant, placed.id).expect(409);

    const shipped = await ship(tenant, placed.id, { courier: 'DHL', tracking: 'JD0001' }).expect(200);
    expectDocumented(orderResponseSchema, shipped.body);
    const body = shipped.body as Order;
    expect(body.state).toBe('shipped');
    expect(body.shipping).toMatchObject({ courier: 'DHL', tracking: 'JD0001', delivered_at: null });
    expect(body.shipping.shipped_at).toEqual(expect.any(String));
    await ship(tenant, placed.id).expect(409);

    // The customer sees the courier and tracking.
    const seen = await tenant.viewer.client.get(`/portal/customers/${tenant.luna}/orders/${placed.id}`).expect(200);
    expectDocumented(customerOrderResponseSchema, seen.body);
    expect(seen.body).toMatchObject({ state: 'shipped', shipping: { courier: 'DHL', tracking: 'JD0001' } });

    const delivered = await deliver(tenant, placed.id).expect(200);
    expectDocumented(orderResponseSchema, delivered.body);
    expect(delivered.body).toMatchObject({ state: 'delivered', shipping: { courier: 'DHL', delivered_at: expect.any(String) } });
    await deliver(tenant, placed.id).expect(409);
    // A shipped order can't be cancelled, nor a delivered one.
    await tenant.staff.post(`/orders/${placed.id}/cancel`, { reason: 'Too late' }).expect(409);

    const audited = await prisma.inTenant(tenant.id, (tx) => tx.auditEntry.count({ where: { action: 'order.changed', subjectId: placed.id } }));
    expect(audited).toBe(3);
  });

  it('ships without a courier or tracking, and checks what it is given', async () => {
    const tenant = await freshTenant();
    const placed = await placeOrder(tenant);
    await finish(tenant, placed);

    await ship(tenant, placed.id, { courier: '', tracking: 'x' }).expect(400);
    await ship(tenant, placed.id, { courier: 'x'.repeat(101) }).expect(400);
    await ship(tenant, placed.id, { carrier: 'DHL' }).expect(400);
    const shipped = (await ship(tenant, placed.id).expect(200)).body as Order;
    expect(shipped.shipping).toMatchObject({ courier: null, tracking: null });
  });

  it("tells the customer's people and staff of each step, and nobody else", async () => {
    const tenant = await freshTenant();
    const placed = await placeOrder(tenant);
    const lunaPeople = [tenant.buyer.email, tenant.viewer.email].sort();

    // Placing: the customer hears it was placed, staff who read orders that one came in.
    expect(await raised(tenant, placed.id)).toEqual([
      { event: 'order.placed', payload: { number: String(placed.number) } },
      { event: 'order.received', payload: { number: String(placed.number), customer_name: 'Luna Jewels' } },
    ]);
    // Only Luna's active people; never Sol's, and never staff.
    expect(await reached(tenant, placed.id, 'order.placed')).toEqual(lunaPeople);
    expect(await reached(tenant, placed.id, 'order.received')).toEqual([...tenant.staffEmails].sort());

    await finish(tenant, placed);
    await ship(tenant, placed.id, { courier: 'DHL', tracking: 'JD0001' }).expect(200);
    await deliver(tenant, placed.id).expect(200);
    expect(await raised(tenant, placed.id)).toEqual([
      { event: 'order.delivered', payload: { number: String(placed.number) } },
      { event: 'order.placed', payload: { number: String(placed.number) } },
      { event: 'order.received', payload: { number: String(placed.number), customer_name: 'Luna Jewels' } },
      { event: 'order.shipped', payload: { number: String(placed.number), courier: 'DHL', tracking: 'JD0001' } },
    ]);
    expect(await reached(tenant, placed.id, 'order.shipped')).toEqual(lunaPeople);
  });

  it('tells the customer when staff cancel its order, not when it cancels it itself', async () => {
    const tenant = await freshTenant();
    const byStaff = await placeOrder(tenant);
    const byCustomer = await placeOrder(tenant);

    await tenant.staff.post(`/orders/${byStaff.id}/cancel`, { reason: 'Out of silver' }).expect(200);
    await tenant.buyer.client.post(`/portal/customers/${tenant.luna}/orders/${byCustomer.id}/cancel`, { reason: 'Changed my mind' }).expect(200);

    expect((await raised(tenant, byStaff.id)).map((row) => row.event)).toEqual(['order.cancelled', 'order.placed', 'order.received']);
    expect((await raised(tenant, byStaff.id))[0].payload).toEqual({ number: String(byStaff.number), reason: 'Out of silver' });
    expect((await raised(tenant, byCustomer.id)).map((row) => row.event)).toEqual(['order.placed', 'order.received']);

    // Cancelling some lines only leaves the order open: no cancelled notice yet.
    const partly = (
      await tenant.staff
        .post('/orders', {
          customer_id: tenant.luna,
          lines: [{ quote_id: await tenant.quote() }, { quote_id: await tenant.quote() }],
          address,
          shipping_method: 'courier',
        })
        .expect(201)
    ).body as Order;
    await tenant.staff.post(`/orders/${partly.id}/cancel`, { reason: 'One is enough', lines: [1] }).expect(200);
    expect((await raised(tenant, partly.id)).map((row) => row.event)).toEqual(['order.placed', 'order.received']);
  });

  it('lets only those who may ship ship and deliver, in their own workspace', async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const placed = await placeOrder(tenant);
    await finish(tenant, placed);

    await ship(tenant, placed.id, {}, tenant.member).expect(403);
    await ship(tenant, placed.id, {}, other.staff).expect(404);
    await ship(tenant, placed.id).expect(200);
    await deliver(tenant, placed.id, tenant.member).expect(403);
    await deliver(tenant, placed.id, other.staff).expect(404);
    await tenant.buyer.client.post(`/orders/${placed.id}/deliver`).expect(403);
  });
});
