import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog } from '../src/cli/seed-catalog';
import { seedCustomers } from '../src/cli/seed-customers';
import { seedOrders } from '../src/cli/seed-orders';
import { seedPricing } from '../src/cli/seed-pricing';
import { seedWorkflows } from '../src/cli/seed-workflows';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { measuredDesign } from './catalog-fixtures';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'demo-password-123';
const CALENDAR = { workingDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17, closedDates: [] };

describe('orders demo seed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
  });

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

  async function seededTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await seedCatalog(prisma, tenant.id);
    await seedPricing(prisma, tenant.id);
    await seedWorkflows(prisma, tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    return { ...tenant, staff: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken) };
  }

  it('creates two shipping methods, two tax rates and the calendar once, and a second run creates nothing', async () => {
    const tenant = await seededTenant();

    expect(await seedOrders(prisma, tenant.id)).toEqual({ shippingMethods: 2, taxRates: 2, calendar: 1, scheduling: 1 });
    expect(await seedOrders(prisma, tenant.id)).toEqual({ shippingMethods: 0, taxRates: 0, calendar: 0, scheduling: 0 });
    // Due dates count back 2 working days from the promised date, 1 more for a part of an assembly.
    expect(((await tenant.staff.get('/settings').expect(200)).body as { data: Record<string, unknown> }).data['orders.scheduling']).toEqual({
      bufferDays: 2,
      assemblyAllowanceDays: 1,
    });

    const methods = ((await tenant.staff.get('/orders/shipping-methods').expect(200)).body as {
      data: { key: string; price: string; active: boolean }[];
    }).data;
    expect(methods.map((method) => [method.key, method.price, method.active])).toEqual([
      ['collect', '0.00', true],
      ['courier', '9.90', true],
    ]);
    expect((await tenant.staff.get('/orders/tax-rates').expect(200)).body).toEqual({
      data: [
        { country: null, region: null, percent: '0' },
        { country: 'DE', region: null, percent: '19' },
      ],
    });
    expect(((await tenant.staff.get('/settings').expect(200)).body as { data: Record<string, unknown> }).data['business.calendar']).toEqual(CALENDAR);
  });

  it("leaves the workspace's own calendar, methods and rates as they are", async () => {
    const tenant = await seededTenant();
    const own = { workingDays: [1, 2, 3, 4], startHour: 8, endHour: 16, closedDates: ['2026-12-25'] };
    await tenant.staff.put('/settings/business.calendar', own).expect(200);
    await tenant.staff.put('/settings/orders.scheduling', { bufferDays: 5, assemblyAllowanceDays: 0 }).expect(200);
    await tenant.staff.post('/orders/shipping-methods', { key: 'courier', name: 'Our courier', price: '12.00' }).expect(201);
    await tenant.staff.put('/orders/tax-rates', { rates: [{ country: 'DE', region: null, percent: '7' }] }).expect(200);

    expect(await seedOrders(prisma, tenant.id)).toEqual({ shippingMethods: 1, taxRates: 1, calendar: 0, scheduling: 0 });

    const methods = ((await tenant.staff.get('/orders/shipping-methods').expect(200)).body as { data: { key: string; price: string }[] }).data;
    expect(methods.map((method) => [method.key, method.price])).toEqual([
      ['collect', '0.00'],
      ['courier', '12.00'],
    ]);
    expect((await tenant.staff.get('/orders/tax-rates').expect(200)).body).toEqual({
      data: [
        { country: null, region: null, percent: '0' },
        { country: 'DE', region: null, percent: '7' },
      ],
    });
    const settings = ((await tenant.staff.get('/settings').expect(200)).body as { data: Record<string, unknown> }).data;
    expect(settings['business.calendar']).toEqual(own);
    expect(settings['orders.scheduling']).toEqual({ bufferDays: 5, assemblyAllowanceDays: 0 });
  });

  it('lets Ben order the demo cast part with courier shipping, taxed for Germany', async () => {
    const tenant = await seededTenant();
    await seedCustomers(prisma, tenant.id, { password: PASSWORD });
    await seedOrders(prisma, tenant.id);

    const login = await http().post('/auth/login').send({ email: 'ben@luna.example.test', password: PASSWORD, workspace: tenant.slug }).expect(200);
    const ben = as((login.body as { access_token: string }).access_token);
    const me = (await ben.get('/portal/me').expect(200)).body as { user: { id: string }; customers: { id: string }[] };
    const luna = me.customers[0].id;
    const portal = `/portal/customers/${luna}`;

    const methods = ((await ben.get(`${portal}/shipping-methods`).expect(200)).body as { data: { key: string }[] }).data;
    expect(methods.map((method) => method.key)).toEqual(['collect', 'courier']);

    const product = await prisma.inTenant(tenant.id, (tx) => tx.product.findFirstOrThrow({ where: { key: 'custom_cast_part' } }));
    const design = await measuredDesign(prisma, tenant.id, me.user.id, { customerId: luna });
    const quoted = await ben
      .post(`${portal}/quotes`, {
        product_id: product.id,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        quantity: 10,
        file_version_id: design.versionId,
      })
      .expect(201);
    const quote = (quoted.body as { quote: { id: string } }).quote;

    const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
    const placed = await ben.post(`${portal}/orders`, { lines: [{ quote_id: quote.id }], address, shipping_method: 'courier' }).expect(201);
    expect(placed.body).toMatchObject({ number: 1001, shipping: { price: '9.90' }, tax: { percent: '19' } });
  });
});
