import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { customerResponseSchema } from '../src/modules/customers/customer-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { customerOrderResponseSchema, orderResponseSchema } from '../src/modules/orders/order-response';
import { paymentTermsResponseSchema } from '../src/modules/payments/payment-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Quote {
  id: string;
  total: string;
}

/**
 * Payment terms (Payments plan, Task 4): each customer pays first or later, an order freezes the
 * terms it was placed under, and staff and the customer both see the order's payment state.
 */
describe('payments: terms and the payment state of an order', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
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

  /** The priced cast part, published; `courier` at 9.90; tax at 19 % everywhere; Luna Jewels with a buyer. */
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

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const buyerUser = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.user.update({ where: { id: buyerUser.id }, data: { kind: 'customer' } });
      await tx.organisationMembership.create({
        data: { userId: buyerUser.id, organisationType: 'customer', organisationId: luna, role: 'buyer' },
      });
    });

    const placeOrder = async () => {
      const quote = ((
        await staff
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 10,
            file_version_id: cast.versionId,
            customer_id: luna,
          })
          .expect(201)
      ).body as { quote: Quote }).quote;
      return staff
        .post('/orders', {
          customer_id: luna,
          lines: [{ quote_id: quote.id }],
          address: { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
          shipping_method: 'courier',
        })
        .expect(201);
    };

    return {
      id: tenant.id,
      ownerId: owner.id,
      staff,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      buyer: as((await tokens.issueForUser(tenant.id, buyerUser.id)).accessToken),
      luna,
      placeOrder,
    };
  }

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

  it('shows a customer without terms as paying first, within 30 days, with no limit', async () => {
    const tenant = await freshTenant();

    const res = await tenant.staff.get(`/customers/${tenant.luna}`).expect(200);

    expectDocumented(customerResponseSchema, res.body);
    expect((res.body as { payment_terms: unknown }).payment_terms).toEqual({
      terms: 'pay_first',
      days_to_pay: 30,
      credit_limit: null,
    });
  });

  it("sets a customer's terms, audits the change and shows them on the customer", async () => {
    const tenant = await freshTenant();

    const res = await tenant.staff
      .put(`/customers/${tenant.luna}/payment-terms`, { terms: 'pay_later', days_to_pay: 14, credit_limit: '5000' })
      .expect(200);

    expectDocumented(paymentTermsResponseSchema, res.body);
    expect(res.body).toEqual({ terms: 'pay_later', days_to_pay: 14, credit_limit: '5000.00' });
    const customer = await tenant.staff.get(`/customers/${tenant.luna}`).expect(200);
    expect((customer.body as { payment_terms: unknown }).payment_terms).toEqual({
      terms: 'pay_later',
      days_to_pay: 14,
      credit_limit: '5000.00',
    });
    const entries = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'customer.payment_terms.changed', subjectId: tenant.luna } }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorId: tenant.ownerId });

    // Without a limit, and with the default days, set again.
    const again = await tenant.staff.put(`/customers/${tenant.luna}/payment-terms`, { terms: 'pay_later' }).expect(200);
    expect(again.body).toEqual({ terms: 'pay_later', days_to_pay: 30, credit_limit: null });
  });

  it('refuses days to pay outside 1–120, a negative limit, and a member', async () => {
    const tenant = await freshTenant();
    const path = `/customers/${tenant.luna}/payment-terms`;

    await tenant.staff.put(path, { terms: 'pay_later', days_to_pay: 0 }).expect(400);
    await tenant.staff.put(path, { terms: 'pay_later', days_to_pay: 121 }).expect(400);
    await tenant.staff.put(path, { terms: 'pay_later', credit_limit: '-1' }).expect(400);
    await tenant.staff.put(path, { terms: 'sometimes' }).expect(400);
    await tenant.member.put(path, { terms: 'pay_later' }).expect(403);
    await tenant.buyer.get(`/customers/${tenant.luna}`).expect(403);
  });

  it("freezes a pay-later customer's terms on the order, which starts at once and is not billed yet", async () => {
    const tenant = await freshTenant();
    await tenant.staff.put(`/customers/${tenant.luna}/payment-terms`, { terms: 'pay_later' }).expect(200);

    const placed = await tenant.placeOrder();
    const orderId = (placed.body as { id: string }).id;
    // Changing the customer's terms afterwards leaves the order as placed.
    await tenant.staff.put(`/customers/${tenant.luna}/payment-terms`, { terms: 'pay_first' }).expect(200);

    const staffView = await tenant.staff.get(`/orders/${orderId}`).expect(200);
    expectDocumented(orderResponseSchema, staffView.body);
    expect(staffView.body).toMatchObject({
      state: 'in_production',
      payment: {
        terms: 'pay_later',
        state: 'not_billed',
        pay_by: null,
        held_for_credit: false,
        released: null,
        paid: '0.00',
        refunded: '0.00',
        pay_url: null,
        invoice: null,
      },
    });

    const customerView = await tenant.buyer.get(`/portal/customers/${tenant.luna}/orders/${orderId}`).expect(200);
    expectDocumented(customerOrderResponseSchema, customerView.body);
    expect((customerView.body as { payment: unknown }).payment).toEqual({
      state: 'not_billed',
      pay_by: null,
      pay_url: null,
      invoice: null,
      paid: '0.00',
      refunded: '0.00',
    });
    const raw = JSON.stringify(customerView.body);
    for (const word of ['held_for_credit', 'released', 'fee', 'terms']) {
      expect({ word, found: raw.includes(word) }).toEqual({ word, found: false });
    }
  });

  it('places an order of a customer without terms as pay first, waiting for payment', async () => {
    const tenant = await freshTenant();

    const placed = await tenant.placeOrder();

    // No payment keys in this workspace, so no checkout could be opened: the order waits without a link.
    expect(placed.body).toMatchObject({
      state: 'awaiting_payment',
      payment: { terms: 'pay_first', state: 'awaiting_payment', pay_url: null },
    });
    const row = await prisma.inTenant(tenant.id, (tx) =>
      tx.order.findUniqueOrThrow({ where: { id: (placed.body as { id: string }).id } }),
    );
    expect(row.productionStartedAt).toBeNull();
    expect(row.payBy).toBeInstanceOf(Date);
  });
});
