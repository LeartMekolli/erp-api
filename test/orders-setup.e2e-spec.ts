import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { shippingMethodResponseSchema, taxRatesResponseSchema } from '../src/modules/orders/order-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Method {
  id: string;
  key: string;
  name: string;
  price: string;
  active: boolean;
}

/**
 * What an order needs from the workspace before anything is ordered (Orders spec, goals 9 and 10):
 * shipping methods with a price per order, and tax rates per country and region with a default.
 */
describe('orders: shipping methods and tax rates', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const as = (token: string) => ({
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    });
    return {
      id: tenant.id,
      owner: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken),
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
    };
  }

  const audited = (tenantId: string, subjectType: string) =>
    prisma.inTenant(tenantId, (tx) => tx.auditEntry.count({ where: { action: 'pricing.changed', subjectType } }));

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

  it('keeps shipping methods, each with a price per order', async () => {
    const tenant = await freshTenant();

    const courier = await tenant.owner
      .post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.9' })
      .expect(201);
    expectDocumented(shippingMethodResponseSchema, courier.body);
    expect(courier.body).toMatchObject({ key: 'courier', name: 'Standard courier', price: '9.90', active: true });
    await tenant.owner.post('/orders/shipping-methods', { key: 'collect', name: 'Collect at the workshop', price: '0' }).expect(201);

    // Keys are unique; a price is money: no sign, at most cents.
    await tenant.owner.post('/orders/shipping-methods', { key: 'courier', name: 'Again', price: '1' }).expect(409);
    for (const body of [
      { key: 'neg', name: 'Negative', price: '-1' },
      { key: 'fine', name: 'Too fine', price: '9.999' },
      { key: 'Bad Key', name: 'Bad key', price: '1' },
      { key: 'noname', name: '', price: '1' },
    ]) {
      const response = await tenant.owner.post('/orders/shipping-methods', body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }

    // Changed and switched off, never deleted: past orders keep naming it.
    const id = (courier.body as Method).id;
    const changed = await tenant.owner.patch(`/orders/shipping-methods/${id}`, { price: '12.50', active: false }).expect(200);
    expectDocumented(shippingMethodResponseSchema, changed.body);
    expect(changed.body).toMatchObject({ key: 'courier', price: '12.50', active: false });
    await tenant.owner.patch(`/orders/shipping-methods/${newId()}`, { price: '1' }).expect(404);
    await tenant.owner.patch('/orders/shipping-methods/not-an-id', { price: '1' }).expect(400);

    const listed = await tenant.owner.get('/orders/shipping-methods').expect(200);
    const methods = (listed.body as { data: Method[] }).data;
    methods.forEach((method) => expectDocumented(shippingMethodResponseSchema, method));
    expect(methods.map((method) => [method.key, method.price, method.active])).toEqual([
      ['collect', '0.00', true],
      ['courier', '12.50', false],
    ]);
    expect(await audited(tenant.id, 'shipping_method')).toBe(3);
  });

  it('keeps tax rates per country and region, with a default, replaced as a whole', async () => {
    const tenant = await freshTenant();

    expect((await tenant.owner.get('/orders/tax-rates').expect(200)).body).toEqual({ data: [] });

    const set = await tenant.owner
      .put('/orders/tax-rates', {
        rates: [
          { country: 'DE', region: 'BY', percent: '17' },
          { country: 'DE', region: null, percent: '19' },
          { country: null, region: null, percent: '0' },
          { country: 'AT', region: null, percent: '20' },
        ],
      })
      .expect(200);
    expectDocumented(taxRatesResponseSchema, set.body);
    // The default first, then by country and region.
    expect(set.body).toEqual({
      data: [
        { country: null, region: null, percent: '0' },
        { country: 'AT', region: null, percent: '20' },
        { country: 'DE', region: null, percent: '19' },
        { country: 'DE', region: 'BY', percent: '17' },
      ],
    });
    expect((await tenant.owner.get('/orders/tax-rates').expect(200)).body).toEqual(set.body);

    // Replacing drops what isn't sent.
    const replaced = await tenant.owner.put('/orders/tax-rates', { rates: [{ country: 'DE', region: null, percent: '19' }] }).expect(200);
    expect(replaced.body).toEqual({ data: [{ country: 'DE', region: null, percent: '19' }] });

    for (const rates of [
      [{ country: null, region: 'BY', percent: '19' }], // a region needs a country
      [{ country: 'de', region: null, percent: '19' }], // ISO codes are upper case
      [{ country: 'DEU', region: null, percent: '19' }], // two letters
      [{ country: 'DE', region: null, percent: '101' }],
      [{ country: 'DE', region: null, percent: '-1' }],
      [
        { country: 'DE', region: null, percent: '19' },
        { country: 'DE', region: null, percent: '7' },
      ], // twice the same place
      [
        { country: null, region: null, percent: '0' },
        { country: null, region: null, percent: '5' },
      ], // two defaults
    ]) {
      const response = await tenant.owner.put('/orders/tax-rates', { rates });
      expect({ rates, status: response.status }).toEqual({ rates, status: 400 });
    }
    expect(await audited(tenant.id, 'tax_rates')).toBe(2);
  });

  it('keeps shipping and tax to staff who may change pricing, and to the workspace', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const method = (await b.owner.post('/orders/shipping-methods', { key: 'courier', name: 'Courier', price: '5' }).expect(201))
      .body as Method;
    await b.owner.put('/orders/tax-rates', { rates: [{ country: 'DE', region: null, percent: '19' }] }).expect(200);

    // Members don't see or change pricing setup.
    await a.member.get('/orders/shipping-methods').expect(403);
    await a.member.post('/orders/shipping-methods', { key: 'courier', name: 'Courier', price: '5' }).expect(403);
    await a.member.get('/orders/tax-rates').expect(403);
    await a.member.put('/orders/tax-rates', { rates: [] }).expect(403);

    // Another workspace's are not there.
    expect((await a.owner.get('/orders/shipping-methods').expect(200)).body).toEqual({ data: [] });
    expect((await a.owner.get('/orders/tax-rates').expect(200)).body).toEqual({ data: [] });
    await a.owner.patch(`/orders/shipping-methods/${method.id}`, { price: '1' }).expect(404);
    // The same key in another workspace is fine.
    await a.owner.post('/orders/shipping-methods', { key: 'courier', name: 'Courier', price: '7' }).expect(201);
  });
});
