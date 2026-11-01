import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { customerResponseSchema } from '../src/modules/customers/customer-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { ReportsService } from '../src/modules/reporting/reports.service';
import { addDays, weekOf } from '../src/modules/reporting/week-metrics';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Customer {
  id: string;
  name: string;
  customer_group: { id: string; key: string; name: string } | null;
}

/**
 * Customers 2, Task 1: customer groups beyond pricing. "Wholesale" takes 0 %, so it only sorts
 * customers; "Retail" adds 5 %.
 */
describe('customers: customer groups', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let reports: ReportsService;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const id = (response: request.Response) => (response.body as { id: string }).id;

  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const staff = {
      post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    };
    const wholesale = id(await staff.post('/pricing/customer-groups', { key: 'wholesale', name: 'Wholesale', percent: '0' }).expect(201));
    const retail = id(await staff.post('/pricing/customer-groups', { key: 'retail', name: 'Retail', percent: '5' }).expect(201));
    const customer = async (name: string, groupId?: string) => {
      const created = id(await staff.post('/customers', { name, ...(groupId ? { customer_group_id: groupId } : {}) }).expect(201));
      await staff.put(`/customers/${created}/payment-terms`, { terms: 'pay_later' }).expect(200);
      return created;
    };
    return { id: tenant.id, owner, staff, wholesale, retail, customer };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const listed = async (w: Workspace, query: string) => {
    const response = await w.staff.get(`/customers?limit=100${query}`).expect(200);
    expectDocumented(pageSchema(customerResponseSchema), response.body);
    return (response.body as { data: Customer[] }).data.map((customer) => customer.name).sort();
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    reports = app.get(ReportsService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('filters customers by group, and by no group', async () => {
    const w = await workspace();
    await w.customer('Luna Jewels', w.wholesale);
    await w.customer('Mare Atelier', w.wholesale);
    await w.customer('Sol Studio', w.retail);
    await w.customer('Terra Rings');

    expect(await listed(w, `&customer_group=${w.wholesale}`)).toEqual(['Luna Jewels', 'Mare Atelier']);
    expect(await listed(w, `&customer_group=${w.retail}`)).toEqual(['Sol Studio']);
    expect(await listed(w, '&customer_group=none')).toEqual(['Terra Rings']);
    expect(await listed(w, '')).toHaveLength(4);

    // A group of no workspace, or not a group at all.
    await w.staff.get(`/customers?customer_group=${newId()}`).expect(400);
    await w.staff.get('/customers?customer_group=wholesale').expect(400);
  });

  it('keeps the group an order was placed under (Review Focus 1)', async () => {
    const w = await workspace();
    const cast = await pricedCastPart(w.staff, prisma, { id: w.id, staffUserId: w.owner.id, runMetal });
    await w.staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await w.staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    const luna = await w.customer('Luna Jewels', w.wholesale);
    const sol = await w.customer('Sol Studio');

    const order = async (customerId: string, quantity: number) => {
      const quote = ((
        await w.staff
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity,
            file_version_id: cast.versionId,
            customer_id: customerId,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote;
      const placed = await w.staff
        .post('/orders', {
          customer_id: customerId,
          lines: [{ quote_id: quote.id }],
          address: { name: 'Studio', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
          shipping_method: 'courier',
        })
        .expect(201);
      const body = placed.body as { total: string; tax: { amount: string } };
      return new Prisma.Decimal(body.total).sub(body.tax.amount);
    };

    const asWholesale = await order(luna, 2);
    // Luna moves to Retail; its first order stays Wholesale's.
    await w.staff.patch(`/customers/${luna}`, { customer_group_id: w.retail }).expect(200);
    const asRetail = await order(luna, 3);
    const ungrouped = await order(sol, 4);

    const { start } = weekOf(new Date(), 'UTC');
    const range = await reports.metricsFor(w.id, { from: start, to: addDays(start, 6) });
    expect(range.orders.by_customer_group).toEqual(
      expect.arrayContaining([
        { customer_group: { id: w.wholesale, key: 'wholesale', name: 'Wholesale' }, revenue: asWholesale.toFixed(2) },
        { customer_group: { id: w.retail, key: 'retail', name: 'Retail' }, revenue: asRetail.toFixed(2) },
      ]),
    );
    expect(range.orders.by_customer_group.at(-1)).toEqual({ customer_group: null, revenue: ungrouped.toFixed(2) });
    // The groups always add up to the revenue.
    const sum = range.orders.by_customer_group.reduce((total, row) => total.add(row.revenue), new Prisma.Decimal(0));
    expect(sum.toFixed(2)).toBe(range.orders.revenue);
  });
});
