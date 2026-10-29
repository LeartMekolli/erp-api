import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { searchResponseSchema } from '../src/modules/ai/search-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Found {
  orders: { id: string; number: number; customer: { id: string; name: string } }[];
  customers: { id: string; name: string }[];
  partners: { id: string; name: string }[];
  articles: { id: string; title: string }[];
}

const SETUP_MS = 60_000;

/** Cmd+K finds orders, customers, partners and articles: plain search, no AI (AI 1 plan, Task 7). */
describe('ai: Cmd+K search', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });
  type Client = ReturnType<typeof as>;

  let owner: Client;
  let clerk: Client;
  let customerPerson: Client;
  let other: Client;
  let brightline: string;
  let northcast: string;
  let article: string;
  const orders: Record<number, string> = {};

  /**
   * Brightline with orders 1042, 1043 and 2104; Northcast Foundry; a published article on casting and a
   * draft. A clerk reads orders and customers but not partners; a customer person reads nothing here.
   */
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);

    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const ownerUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const clerkUser = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      const role = await tx.role.create({ data: { name: 'clerk', isSystem: false } });
      await tx.rolePermission.createMany({ data: ['order.read', 'customer.read'].map((permission) => ({ roleId: role.id, permission })) });
      await tx.userRole.create({ data: { userId: clerkUser.id, roleId: role.id } });
    });
    owner = as((await tokens.issueForUser(tenant.id, ownerUser.id)).accessToken);
    clerk = as((await tokens.issueForUser(tenant.id, clerkUser.id)).accessToken);

    const cast = await pricedCastPart(owner, prisma, { id: tenant.id, staffUserId: ownerUser.id, runMetal });
    await owner.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const speeds = (await owner.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] };
    await owner.patch(`/pricing/delivery-speeds/${speeds.data.find((speed) => speed.key === 'standard')!.id}`, { working_days: 10 }).expect(200);
    await owner.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await owner.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '0' }] }).expect(200);
    brightline = ((await owner.post('/customers', { name: 'Brightline Studio' }).expect(201)).body as { id: string }).id;
    await owner.put(`/customers/${brightline}/payment-terms`, { terms: 'pay_later' }).expect(200);

    for (const number of [1042, 1043, 2104]) {
      const quote = ((
        await owner
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 1,
            file_version_id: cast.versionId,
            customer_id: brightline,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote;
      const placed = (
        await owner
          .post('/orders', {
            customer_id: brightline,
            lines: [{ quote_id: quote.id }],
            address: { name: 'Brightline', line1: 'Main street 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
            shipping_method: 'courier',
          })
          .expect(201)
      ).body as { id: string };
      // Numbers count from 1001; these are set by hand to search by.
      await prisma.inTenant(tenant.id, (tx) => tx.order.update({ where: { id: placed.id }, data: { number } }));
      orders[number] = placed.id;
    }

    northcast = ((await owner.post('/partners', { name: 'Northcast Foundry', display_name: 'Northcast' }).expect(201)).body as { id: string }).id;
    article = ((await owner.post('/knowledge/articles', { title: 'Casting QC checklist', body: 'Weigh it.' }).expect(201)).body as { id: string }).id;
    await owner.post(`/knowledge/articles/${article}/publish`).expect(200);
    await owner.post('/knowledge/articles', { title: 'Casting draft', body: 'Not yet.' }).expect(201);

    const personUser = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.user.update({ where: { id: personUser.id }, data: { kind: 'customer' } });
      await tx.organisationMembership.create({ data: { userId: personUser.id, organisationType: 'customer', organisationId: brightline, role: 'buyer' } });
    });
    customerPerson = as((await tokens.issueForUser(tenant.id, personUser.id)).accessToken);

    const elsewhere = await createTestTenant(prisma);
    createdTenants.push(elsewhere.id);
    other = as((await tokens.issueForUser(elsewhere.id, (await createTestUser(prisma, elsewhere.id, { roles: ['owner'] })).id)).accessToken);
  }, SETUP_MS);

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  const search = async (client: Client, q: string) => {
    const response = await client.get(`/search?q=${encodeURIComponent(q)}`).expect(200);
    expectDocumented(searchResponseSchema, response.body);
    return response.body as Found;
  };

  it('finds orders by the start of their number, with their customer', async () => {
    const found = await search(owner, '104');

    expect(found.orders.map((order) => order.number).sort()).toEqual([1042, 1043]);
    expect(found.orders[0].customer).toEqual({ id: brightline, name: 'Brightline Studio' });
    expect((await search(owner, '2104')).orders.map((order) => order.id)).toEqual([orders[2104]]);
  });

  it('finds customers and partners by any part of their name, ignoring case', async () => {
    expect((await search(owner, 'north')).partners).toEqual([{ id: northcast, name: 'Northcast Foundry' }]);
    expect((await search(owner, 'LINE')).customers).toEqual([{ id: brightline, name: 'Brightline Studio' }]);
  });

  it('finds published articles by title, never a draft', async () => {
    expect((await search(owner, 'casting')).articles).toEqual([{ id: article, title: 'Casting QC checklist' }]);
  });

  it('leaves a kind the user may not read empty', async () => {
    const found = await search(clerk, 'north');

    expect(found.partners).toEqual([]);
    expect((await search(clerk, '104')).orders).toHaveLength(2);
  });

  it('finds nothing of another workspace, and is for staff only', async () => {
    expect(await search(other, 'north')).toEqual({ orders: [], customers: [], partners: [], articles: [] });
    await customerPerson.get('/search?q=north').expect(403);
  });

  it('refuses an empty or too long query', async () => {
    await owner.get('/search?q=').expect(400);
    await owner.get('/search').expect(400);
    await owner.get(`/search?q=${'x'.repeat(101)}`).expect(400);
  });
});
