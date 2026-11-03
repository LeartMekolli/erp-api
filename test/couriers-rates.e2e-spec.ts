import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { COURIER_PROVIDER, CourierError } from '../src/modules/couriers/courier-provider';
import { courierAccountResponseSchema, shippingRatesResponseSchema } from '../src/modules/couriers/courier-response';
import type { FakeCourierProvider } from '../src/modules/couriers/fake-courier-provider';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { orderResponseSchema, portalShippingMethodsResponseSchema, shippingMethodResponseSchema } from '../src/modules/orders/order-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Rate {
  key: string;
  price: string | null;
  available: boolean;
  reason: string | null;
}

const ACCOUNT = {
  api_key: 'EZTKtest_secret_key_123',
  webhook_secret: 'whsec_courier_test',
  from_address: { name: 'Sol Studio', line1: 'Main street 2', city: 'Munich', postal_code: '80331', country: 'DE' },
};
const PARCEL = { weight_g: 1_200, length_cm: 20, width_cm: 15, height_cm: 10 };
const ADDRESS = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };

/**
 * Courier accounts and live rates (Orders 3b plan, Task 3): a shipping method may be priced by the
 * workspace's courier service for each order, fetched before the order's transaction.
 */
describe('couriers: accounts and live rates', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakeCourierProvider;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  /** The cast part, a fixed `courier` at 9.90, a 19 % tax rate, Luna Jewels on pay later with a buyer; no courier account unless `account`. */
  async function workspace(options: { account?: boolean } = {}) {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '19' }] }).expect(200);
    if (options.account !== false) await staff.put('/couriers/account', ACCOUNT).expect(200);

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    await staff.put(`/customers/${luna}/payment-terms`, { terms: 'pay_later' }).expect(200);
    const buyerUser = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.user.update({ where: { id: buyerUser.id }, data: { kind: 'customer' } });
      await tx.organisationMembership.create({ data: { userId: buyerUser.id, organisationType: 'customer', organisationId: luna, role: 'buyer' } });
    });

    const live = async (key: string, service = 'standard') =>
      staff.post('/orders/shipping-methods', { key, name: `Courier ${key}`, live_rate: { carrier: 'FakeCarrier', service }, default_parcel: PARCEL }).expect(201);
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
    const place = async (method: string, address: object = ADDRESS) =>
      staff.post('/orders', { customer_id: luna, lines: [{ quote_id: await quote() }], address, shipping_method: method });
    const rates = async (address: object = ADDRESS): Promise<Rate[]> => {
      const response = await staff.post('/orders/shipping-rates', { customer_id: luna, address }).expect(200);
      expectDocumented(shippingRatesResponseSchema, response.body);
      return (response.body as { data: Rate[] }).data;
    };
    const orders = () => prisma.inTenant(tenant.id, (tx) => tx.order.count());

    return { id: tenant.id, staff, buyer: as((await tokens.issueForUser(tenant.id, buyerUser.id)).accessToken), luna, live, place, rates, orders };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    fake = app.get<FakeCourierProvider>(COURIER_PROVIDER);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('sets the courier account without ever showing its key', async () => {
    const w = await workspace({ account: false });
    const before = await w.staff.get('/couriers/account').expect(200);
    expectDocumented(courierAccountResponseSchema, before.body);
    expect(before.body).toMatchObject({ configured: false, mode: null });

    const set = await w.staff.put('/couriers/account', ACCOUNT).expect(200);
    expectDocumented(courierAccountResponseSchema, set.body);
    expect(set.body).toEqual({ configured: true, mode: 'test', from_address: ACCOUNT.from_address, webhook_url: `/webhooks/couriers/${w.id}` });
    const audited = await prisma.inTenant(w.id, (tx) => tx.auditEntry.findMany({ where: { subjectType: 'courier_account' } }));
    expect(audited).toHaveLength(1);
    expect(JSON.stringify([set.body, audited])).not.toContain(ACCOUNT.api_key);
    expect(JSON.stringify(audited)).not.toContain(ACCOUNT.webhook_secret);
  });

  it('prices an order with a live-rate method', async () => {
    const w = await workspace();
    const created = await w.live('live');
    expectDocumented(shippingMethodResponseSchema, created.body);
    expect(created.body).toMatchObject({ price: null, live_rate: { carrier: 'FakeCarrier', service: 'standard' }, default_parcel: PARCEL });

    const rates = await w.rates();
    expect(rates.map((rate) => [rate.key, rate.price, rate.available])).toEqual([
      ['courier', '9.90', true],
      ['live', '6.90', true],
    ]);
    const portal = await w.buyer.get(`/portal/customers/${w.luna}/shipping-methods`).expect(200);
    expectDocumented(portalShippingMethodsResponseSchema, portal.body);
    expect((portal.body as { data: { key: string; price: string | null }[] }).data.find((one) => one.key === 'live')!.price).toBeNull();
    const portalRates = await w.buyer.post(`/portal/customers/${w.luna}/shipping-rates`, { address: ADDRESS }).expect(200);
    expectDocumented(shippingRatesResponseSchema, portalRates.body);

    const placed = await w.place('live');
    expect(placed.status).toBe(201);
    expectDocumented(orderResponseSchema, placed.body);
    const order = placed.body as { shipping: { price: string }; lines_total: string; tax: { amount: string } };
    expect(order.shipping.price).toBe('6.90');
    const fixed = (await w.place('courier')).body as { lines_total: string; tax: { amount: string } };
    // Tax is on the shipping too: the live order's tax is 19 % of 6.90 less than the fixed one's of 9.90.
    expect(Number(fixed.tax.amount) - Number(order.tax.amount)).toBeCloseTo(0.19 * (9.9 - 6.9), 2);
  });

  it('refuses a live method with no account, no rate or a foreign currency (Review Focus 4)', async () => {
    const noAccount = await workspace({ account: false });
    await noAccount.live('live');
    expect((await noAccount.rates()).find((rate) => rate.key === 'live')).toMatchObject({ available: false, price: null });
    expect((await noAccount.place('live')).status).toBe(400);

    const w = await workspace();
    await w.live('nothing', 'none');
    await w.live('live');
    const rates = await w.rates({ ...ADDRESS, country: 'US' });
    expect(rates.find((rate) => rate.key === 'nothing')).toMatchObject({ available: false });
    expect(rates.find((rate) => rate.key === 'live')!.reason).toMatch(/USD/);
    const refused = await w.place('nothing');
    expect(refused.status).toBe(400);
    expect((refused.body as { errors: { path: string }[] }).errors[0].path).toBe('shipping_method');
    expect((await w.place('live', { ...ADDRESS, country: 'US' })).status).toBe(400);
    expect(await w.orders()).toBe(0);
  });

  it('places with a fixed method while the courier service is down, and refuses a live one', async () => {
    const w = await workspace();
    await w.live('live');
    jest.spyOn(fake, 'shipment').mockRejectedValue(new CourierError('The courier service is not answering'));
    expect((await w.place('courier')).status).toBe(201);
    expect((await w.place('live')).status).toBe(503);
    expect(await w.orders()).toBe(1);
    expect((await w.rates()).find((rate) => rate.key === 'live')).toMatchObject({ available: false, reason: 'The courier service is not answering' });
  });

  it('refuses a live method with a price, or without a parcel', async () => {
    const w = await workspace();
    const live_rate = { carrier: 'FakeCarrier', service: 'standard' };
    await w.staff.post('/orders/shipping-methods', { key: 'both', name: 'Both', price: '5.00', live_rate, default_parcel: PARCEL }).expect(400);
    await w.staff.post('/orders/shipping-methods', { key: 'noparcel', name: 'No parcel', live_rate }).expect(400);
    await w.staff.post('/orders/shipping-methods', { key: 'neither', name: 'Neither' }).expect(400);
  });
});
