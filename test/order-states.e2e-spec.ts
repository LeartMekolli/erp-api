import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { expectStoredStates } from './stored-states';

interface Order {
  id: string;
  lines: { group_id: string }[];
}

/**
 * Each order's state and payment state are stored, and kept equal to what its facts give, by every
 * change that can move them (Orders list spec, goals 1–7; plan Task 1 onwards).
 */
describe('orders: stored states', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
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

  /** The priced cast part, published; `courier`; Luna Jewels paying later, Sol Studio paying first (no terms set). */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const staff = as(token);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const sol = ((await staff.post('/customers', { name: 'Sol Studio' }).expect(201)).body as { id: string }).id;
    await staff.put(`/customers/${luna}/payment-terms`, { terms: 'pay_later' }).expect(200);

    const place = async (customerId: string) => {
      const quote = (
        (
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
        ).body as { quote: { id: string } }
      ).quote.id;
      return (await staff.post('/orders', { customer_id: customerId, lines: [{ quote_id: quote }], address, shipping_method: 'courier' }).expect(201))
        .body as Order;
    };

    return { id: tenant.id, token, staff, luna, sol, place };
  }

  const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
  /** What is stored on the order, read straight from the database. */
  const stored = (tenantId: string, id: string) =>
    prisma.inTenant(tenantId, (tx) => tx.order.findUniqueOrThrow({ where: { id }, select: { state: true, paymentState: true } }));

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

  it("stores each order's state and payment state as Orders changes it", async () => {
    const tenant = await freshTenant();

    const later = await tenant.place(tenant.luna);
    expect(await stored(tenant.id, later.id)).toEqual({ state: 'in_production', paymentState: 'not_billed' });
    const first = await tenant.place(tenant.sol);
    expect(await stored(tenant.id, first.id)).toEqual({ state: 'awaiting_payment', paymentState: 'awaiting_payment' });
    await expectStoredStates(prisma, app, tenant.id, tenant.token);

    // Finished directly, as orders-shipping does: a move keeping the stored state current is Task 2's to test.
    await prisma.inTenant(tenant.id, (tx) =>
      tx.workOrder.updateMany({ where: { groupId: { in: later.lines.map((line) => line.group_id) } }, data: { status: 'finished', currentStepId: null } }),
    );
    await tenant.staff.post(`/orders/${later.id}/ship`, { courier: 'DHL', tracking: 'JD0001' }).expect(200);
    // No payment provider is connected, so no invoice is made: still not billed.
    expect(await stored(tenant.id, later.id)).toEqual({ state: 'shipped', paymentState: 'not_billed' });
    await expectStoredStates(prisma, app, tenant.id, tenant.token);

    await tenant.staff.post(`/orders/${later.id}/deliver`).expect(200);
    expect(await stored(tenant.id, later.id)).toMatchObject({ state: 'delivered' });
    await expectStoredStates(prisma, app, tenant.id, tenant.token);

    await tenant.staff.post(`/orders/${first.id}/cancel`, { reason: 'Changed their mind' }).expect(200);
    expect(await stored(tenant.id, first.id)).toEqual({ state: 'cancelled', paymentState: 'none' });
    await expectStoredStates(prisma, app, tenant.id, tenant.token);
  });
});
