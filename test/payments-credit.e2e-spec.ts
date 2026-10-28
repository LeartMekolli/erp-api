import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { orderResponseSchema } from '../src/modules/orders/order-response';
import { paymentCustomerResponseSchema } from '../src/modules/payments/payment-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface StaffOrder {
  id: string;
  state: string;
  total: string;
  payment: {
    terms: string;
    state: string;
    held_for_credit: boolean;
    pay_url: string | null;
    pay_by: string | null;
    released: { by: { id: string; name: string }; reason: string } | null;
  };
}

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const d = (value: string) => new Prisma.Decimal(value);

/**
 * Pay later within a credit limit (Payments plan, Task 7): an order that would take what the customer
 * owes past its limit waits for a card payment, as a pay-first order does, until staff release it.
 */
describe('payments: pay later and the credit limit', () => {
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

  /**
   * The priced cast part, published; `courier` at 9.90; tax at 19 %; the workspace's payment keys;
   * Brightline, paying later within 30 days.
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
    const brightline = ((await staff.post('/customers', { name: 'Brightline' }).expect(201)).body as { id: string }).id;
    const terms = (credit_limit: string | null) =>
      staff.put(`/customers/${brightline}/payment-terms`, { terms: 'pay_later', days_to_pay: 30, credit_limit }).expect(200);
    await terms(null);

    /** Brightline's order of one line, placed by staff; the quote is made first, so orders can be placed at once. */
    const quote = async (quantity = 10) =>
      ((
        await staff
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity,
            file_version_id: cast.versionId,
            customer_id: brightline,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote.id;
    const order = (quoteId: string) =>
      staff.post('/orders', {
        customer_id: brightline,
        lines: [{ quote_id: quoteId }],
        address: { name: 'Brightline', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
        shipping_method: 'courier',
      });
    const place = async (quantity = 10) => (await order(await quote(quantity)).expect(201)).body as StaffOrder;

    return {
      id: tenant.id,
      ownerId: owner.id,
      staff,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      brightline,
      terms,
      quote,
      order,
      place,
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

  it('holds an order past the limit until staff release it, and counts the released one', async () => {
    const tenant = await freshTenant();
    const first = await tenant.place(10);
    expect(first).toMatchObject({ state: 'in_production', payment: { terms: 'pay_later', held_for_credit: false } });
    // Room for the first order and a cent more.
    await tenant.terms(d(first.total).plus('0.01').toFixed(2));

    const second = await tenant.place(10);

    expectDocumented(orderResponseSchema, second);
    expect(second).toMatchObject({
      state: 'awaiting_payment',
      payment: { terms: 'pay_later', state: 'awaiting_payment', held_for_credit: true, released: null },
    });
    expect(second.payment.pay_url).toEqual(expect.any(String));
    expect(second.payment.pay_by).toEqual(expect.any(String));

    const released = await tenant.staff.post(`/orders/${second.id}/release`, { reason: 'Long-standing customer, approved by Ana' }).expect(200);

    expectDocumented(orderResponseSchema, released.body);
    expect(released.body).toMatchObject({
      state: 'in_production',
      payment: {
        state: 'not_billed',
        // No longer waiting; `released` keeps who let it through, and why.
        held_for_credit: false,
        pay_by: null,
        pay_url: null,
        released: { by: { id: tenant.ownerId }, reason: 'Long-standing customer, approved by Ana' },
      },
    });
    const checkouts = await prisma.inTenant(tenant.id, (tx) => tx.orderPayment.findMany({ where: { orderId: second.id } }));
    expect(checkouts.map((checkout) => checkout.status)).toEqual(['expired']);
    const audited = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'order.changed', subjectId: second.id }, orderBy: { id: 'asc' } }),
    );
    expect(audited.at(-1)).toMatchObject({ actorId: tenant.ownerId });
    await tenant.staff.post(`/orders/${second.id}/release`, { reason: 'Again' }).expect(409);

    // Both now count against the limit, so even a small order waits.
    const third = await tenant.place(1);
    expect(third.payment).toMatchObject({ held_for_credit: true, state: 'awaiting_payment' });

    const money = await tenant.staff.get(`/payments/customers/${tenant.brightline}`).expect(200);
    expectDocumented(paymentCustomerResponseSchema, money.body);
    expect(money.body).toMatchObject({
      terms: 'pay_later',
      days_to_pay: 30,
      credit_limit: d(first.total).plus('0.01').toFixed(2),
      exposure: d(first.total).plus(second.total).toFixed(2),
      balance: '0.00',
      open_invoices: [],
      overdue_invoices: [],
    });
  });

  it('refuses releasing an order not held for credit, an empty reason, and a member', async () => {
    const tenant = await freshTenant();
    const started = await tenant.place(10);
    await tenant.terms('1.00');
    const held = await tenant.place(10);

    await tenant.staff.post(`/orders/${started.id}/release`, { reason: 'Why not' }).expect(409);
    await tenant.staff.post(`/orders/${held.id}/release`, { reason: '' }).expect(400);
    await tenant.member.post(`/orders/${held.id}/release`, { reason: 'Please' }).expect(403);
    await tenant.member.get(`/payments/customers/${tenant.brightline}`).expect(200);

    await tenant.staff.post(`/orders/${held.id}/cancel`, { reason: 'Customer withdrew' }).expect(200);
    await tenant.staff.post(`/orders/${held.id}/release`, { reason: 'Too late' }).expect(409);
  });

  it('holds exactly one of two orders placed at once that together pass the limit', async () => {
    const tenant = await freshTenant();
    const probe = await tenant.place(10);
    // The probe is cancelled, so the limit has room for one more order like it, and not two.
    await tenant.staff.post(`/orders/${probe.id}/cancel`, { reason: 'Only a probe' }).expect(200);
    await tenant.terms(d(probe.total).plus('1.00').toFixed(2));
    const quotes = [await tenant.quote(10), await tenant.quote(10)];

    const placed = await Promise.all(quotes.map((quoteId) => tenant.order(quoteId).expect(201)));

    const held = placed.map((res) => (res.body as StaffOrder).payment.held_for_credit);
    expect(held.filter(Boolean)).toHaveLength(1);
  });
});
