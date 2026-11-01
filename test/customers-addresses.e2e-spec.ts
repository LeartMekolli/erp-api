import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { customerAddressesResponseSchema } from '../src/modules/customers/addresses';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Addresses {
  shipping_address: Record<string, string> | null;
  billing_address: Record<string, string> | null;
  vat_number: string | null;
}

const STUDIO = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
const WORKSHOP = { name: 'Luna Jewels workshop', line1: 'Torstraße 9', city: 'Berlin', postal_code: '10119', country: 'DE' };
const HEAD_OFFICE = { name: 'Luna Jewels GmbH', line1: 'Ringstraße 4', city: 'Wien', postal_code: '1010', country: 'AT' };
const FAIR = { name: 'Luna Jewels at the fair', line1: 'Messeplatz 1', city: 'München', postal_code: '81823', country: 'DE' };

/** Customers 2, Task 3: a customer keeps its addresses, and orders start from the shipping one. */
describe('customers: saved addresses', () => {
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

  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    await staff.put(`/customers/${luna}/payment-terms`, { terms: 'pay_later' }).expect(200);
    const person = async (role: string) => {
      const user = await createTestUser(prisma, tenant.id, { roles: [] });
      await prisma.inTenant(tenant.id, async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { kind: 'customer' } });
        await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'customer', organisationId: luna, role } });
      });
      return as((await tokens.issueForUser(tenant.id, user.id)).accessToken);
    };
    return { id: tenant.id, owner, staff, luna, person };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  /** A priced cast part, a shipping method, and a way to place Luna's orders. */
  async function ordering(w: Workspace) {
    const cast = await pricedCastPart(w.staff, prisma, { id: w.id, staffUserId: w.owner.id, runMetal });
    await w.staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await w.staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    return async (status: number, extra: object = {}) => {
      const quote = ((
        await w.staff
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 2,
            file_version_id: cast.versionId,
            customer_id: w.luna,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote;
      return w.staff.post('/orders', { customer_id: w.luna, lines: [{ quote_id: quote.id }], shipping_method: 'courier', ...extra }).expect(status);
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it("staff and the customer's admin save addresses; a buyer and a viewer read them but may not change them", async () => {
    const w = await workspace();
    const empty = await w.staff.get(`/customers/${w.luna}/addresses`).expect(200);
    expectDocumented(customerAddressesResponseSchema, empty.body);
    expect(empty.body).toEqual({ shipping_address: null, billing_address: null, vat_number: null });

    const saved = await w.staff.put(`/customers/${w.luna}/addresses`, { shipping_address: STUDIO, billing_address: HEAD_OFFICE }).expect(200);
    expectDocumented(customerAddressesResponseSchema, saved.body);
    expect(saved.body).toEqual({ shipping_address: STUDIO, billing_address: HEAD_OFFICE, vat_number: null });

    // The admin names only the VAT number; the addresses stay.
    const admin = await w.person('admin');
    const portal = `/portal/customers/${w.luna}/addresses`;
    const withVat = await admin.put(portal, { vat_number: 'ATU12345678' }).expect(200);
    expectDocumented(customerAddressesResponseSchema, withVat.body);
    expect(withVat.body).toEqual({ shipping_address: STUDIO, billing_address: HEAD_OFFICE, vat_number: 'ATU12345678' });
    // Null clears one.
    expect(((await admin.put(portal, { billing_address: null }).expect(200)).body as Addresses).billing_address).toBeNull();

    for (const role of ['buyer', 'viewer']) {
      const reader = await w.person(role);
      const read = await reader.get(portal).expect(200);
      expectDocumented(customerAddressesResponseSchema, read.body);
      expect((read.body as Addresses).vat_number).toBe('ATU12345678');
      await reader.put(portal, { shipping_address: WORKSHOP }).expect(403);
    }

    // An address is checked as an order's is.
    await w.staff.put(`/customers/${w.luna}/addresses`, { shipping_address: { ...STUDIO, country: 'Germany' } }).expect(400);
    await w.staff.put(`/customers/${w.luna}/addresses`, { vat_number: '  ' }).expect(400);
  });

  it('places an order without an address at the saved one, and keeps it when the saved one changes (Review Focus 3)', async () => {
    const w = await workspace();
    const place = await ordering(w);
    await w.staff.put(`/customers/${w.luna}/addresses`, { shipping_address: STUDIO }).expect(200);

    const placed = await place(201);
    const orderId = (placed.body as { id: string }).id;
    expect((placed.body as { address: object }).address).toEqual(STUDIO);

    await w.staff.put(`/customers/${w.luna}/addresses`, { shipping_address: WORKSHOP }).expect(200);
    const again = await w.staff.get(`/orders/${orderId}`).expect(200);
    expect((again.body as { address: object }).address).toEqual(STUDIO);
  });

  it('refuses an order without an address for a customer that saved none', async () => {
    const w = await workspace();
    const place = await ordering(w);
    const refused = await place(400);
    expect(JSON.stringify(refused.body)).toContain('address');
  });

  it('lets an order name its own address, leaving the saved one as it is', async () => {
    const w = await workspace();
    const place = await ordering(w);
    await w.staff.put(`/customers/${w.luna}/addresses`, { shipping_address: STUDIO }).expect(200);

    const placed = await place(201, { address: FAIR });
    expect((placed.body as { address: object }).address).toEqual(FAIR);
    expect(((await w.staff.get(`/customers/${w.luna}/addresses`).expect(200)).body as Addresses).shipping_address).toEqual(STUDIO);
  });
});
