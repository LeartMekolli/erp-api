import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { customerResponseSchema } from '../src/modules/customers/customer-response';
import { customerPriorityResponseSchema } from '../src/modules/customers/priority/priority-response';
import { PriorityService } from '../src/modules/customers/priority/priority.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { localDate } from '../src/modules/orders/dates';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Priority {
  score: number;
  parts: { lifetime: number; recent: number; frequency: number; payment: number };
  computed_band: { key: string; name: string };
  override: { band: { key: string; name: string }; reason: string; ends_on: string } | null;
  band: { key: string; name: string };
  computed_at: string | null;
}

const DAY_MS = 86_400_000;
const SETTINGS = {
  weights: { lifetime: 1, recent: 1, frequency: 1, payment: 1 },
  defaultBand: { key: 'standard', name: 'Standard' },
  bands: [
    { key: 'gold', name: 'Gold', from: 80, firstInLine: true, mayPickPartner: true },
    { key: 'silver', name: 'Silver', from: 50, firstInLine: false, mayPickPartner: false },
  ],
};

/**
 * Customers 2, Task 5. Sol orders three times, the most; Luna twice; Mare once, the least; Nova never.
 * Nobody has an invoice yet, so they tie on paying on time (50 each): Sol scores 88 (Gold), Luna 50
 * (Silver), Mare 13, and Nova, never compared, 0; both Standard.
 */
describe('customers: priority score', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let priority: PriorityService;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/settings/customers.priority', SETTINGS).expect(200);

    const customer = async (name: string) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      await staff.put(`/customers/${id}/payment-terms`, { terms: 'pay_later' }).expect(200);
      await staff.put(`/customers/${id}/addresses`, { shipping_address: { name, line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' } }).expect(200);
      return id;
    };
    const order = async (customerId: string, quantity: number) => {
      const quote = ((
        await staff
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
      await staff.post('/orders', { customer_id: customerId, lines: [{ quote_id: quote.id }], shipping_method: 'courier' }).expect(201);
    };

    const sol = await customer('Sol Studio');
    const luna = await customer('Luna Jewels');
    const mare = await customer('Mare Atelier');
    const nova = await customer('Nova Rings');
    for (const quantity of [6, 7, 8]) await order(sol, quantity);
    for (const quantity of [3, 4]) await order(luna, quantity);
    await order(mare, 1);

    const timezone = (await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).timezone;
    return {
      id: tenant.id,
      staff,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      sol,
      luna,
      mare,
      nova,
      today: () => localDate(new Date(), timezone),
    };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const priorityOf = async (w: Workspace, customerId: string) => {
    const response = await w.staff.get(`/customers/${customerId}/priority`).expect(200);
    expectDocumented(customerPriorityResponseSchema, response.body);
    return response.body as Priority;
  };
  const bandOf = async (w: Workspace, customerId: string) => (await priorityOf(w, customerId)).band.key;
  const yesterday = (w: Workspace) => new Date(new Date(`${w.today()}T00:00:00Z`).getTime() - DAY_MS);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    priority = app.get(PriorityService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('scores customers from their history and puts them in bands', async () => {
    const w = await workspace();
    // Before the first run, everyone is in the default band.
    expect(await priorityOf(w, w.sol)).toMatchObject({ score: 0, band: { key: 'standard', name: 'Standard' }, override: null, computed_at: null });

    const refreshed = await w.staff.post(`/customers/${w.sol}/priority/refresh`).expect(200);
    expectDocumented(customerPriorityResponseSchema, refreshed.body);

    expect(await priorityOf(w, w.sol)).toMatchObject({
      score: 88,
      parts: { lifetime: 100, recent: 100, frequency: 100, payment: 50 },
      computed_band: { key: 'gold', name: 'Gold' },
      band: { key: 'gold', name: 'Gold' },
    });
    expect(await priorityOf(w, w.luna)).toMatchObject({ score: 50, band: { key: 'silver' } });
    expect(await priorityOf(w, w.mare)).toMatchObject({ score: 13, band: { key: 'standard' } });
    expect(await priorityOf(w, w.nova)).toMatchObject({ score: 0, band: { key: 'standard' } });

    const customer = await w.staff.get(`/customers/${w.sol}`).expect(200);
    expectDocumented(customerResponseSchema, customer.body);
    expect((customer.body as { band: object }).band).toEqual({ key: 'gold', name: 'Gold' });

    // Reading needs customer.read; refreshing needs settings.write.
    await w.member.get(`/customers/${w.sol}/priority`).expect(200);
    await w.member.post(`/customers/${w.sol}/priority/refresh`).expect(403);
  });

  it('overrides a band until a date, audited, then the computed band is back (Review Focus 4)', async () => {
    const w = await workspace();
    await priority.refresh(w.id, new Date());

    const overridden = await w.staff
      .put(`/customers/${w.mare}/priority/override`, { band_key: 'gold', reason: 'Launch partner this season', ends_on: w.today() })
      .expect(200);
    expectDocumented(customerPriorityResponseSchema, overridden.body);
    expect(overridden.body).toMatchObject({
      computed_band: { key: 'standard' },
      override: { band: { key: 'gold', name: 'Gold' }, reason: 'Launch partner this season', ends_on: w.today() },
      band: { key: 'gold' },
    });

    // Its last day is over: the computed band is back without anything running.
    await prisma.inTenant(w.id, (tx) => tx.customerPriority.update({ where: { tenantId_customerId: { tenantId: w.id, customerId: w.mare } }, data: { overrideEndsOn: yesterday(w) } }));
    expect(await bandOf(w, w.mare)).toBe('standard');

    const audited = await prisma.inTenant(w.id, (tx) => tx.auditEntry.findMany({ where: { subjectId: w.mare, action: 'customer.priority_changed' } }));
    expect(audited).toHaveLength(1);

    // Removed by hand; an unknown band, a past end date or no reason is refused.
    await w.staff.put(`/customers/${w.mare}/priority/override`, { band_key: 'silver', reason: 'Trial', ends_on: w.today() }).expect(200);
    await w.staff.delete(`/customers/${w.mare}/priority/override`).expect(204);
    expect(await priorityOf(w, w.mare)).toMatchObject({ override: null, band: { key: 'standard' } });
    await w.staff.put(`/customers/${w.mare}/priority/override`, { band_key: 'platinum', reason: 'Trial', ends_on: w.today() }).expect(400);
    await w.staff.put(`/customers/${w.mare}/priority/override`, { band_key: 'gold', reason: 'Trial', ends_on: '2020-01-31' }).expect(400);
    await w.staff.put(`/customers/${w.mare}/priority/override`, { band_key: 'gold', ends_on: w.today() }).expect(400);
    await w.member.put(`/customers/${w.mare}/priority/override`, { band_key: 'gold', reason: 'Trial', ends_on: w.today() }).expect(403);
  });

  it('reads a removed band as the default (Review Focus 5)', async () => {
    const w = await workspace();
    await priority.refresh(w.id, new Date());
    expect(await bandOf(w, w.sol)).toBe('gold');

    await w.staff.put('/settings/customers.priority', { ...SETTINGS, bands: SETTINGS.bands.filter((band) => band.key !== 'gold') }).expect(200);

    expect(await priorityOf(w, w.sol)).toMatchObject({ computed_band: { key: 'standard' }, band: { key: 'standard' } });
  });

  it('lists customers by band', async () => {
    const w = await workspace();
    await priority.refresh(w.id, new Date());

    const listed = await w.staff.get('/customers?band=gold&limit=100').expect(200);
    expectDocumented(pageSchema(customerResponseSchema), listed.body);
    expect((listed.body as { data: { id: string }[] }).data.map((row) => row.id)).toEqual([w.sol]);
    const standard = await w.staff.get('/customers?band=standard&limit=100').expect(200);
    expect((standard.body as { data: { id: string }[] }).data.map((row) => row.id).sort()).toEqual([w.mare, w.nova].sort());
  });

  it('never shows the score or band to the customer', async () => {
    const w = await workspace();
    await priority.refresh(w.id, new Date());
    const owner = await createTestUser(prisma, w.id, { roles: [] });
    await prisma.inTenant(w.id, async (tx) => {
      await tx.user.update({ where: { id: owner.id }, data: { kind: 'customer' } });
      await tx.organisationMembership.create({ data: { userId: owner.id, organisationType: 'customer', organisationId: w.sol, role: 'owner' } });
    });
    const portal = as((await tokens.issueForUser(w.id, owner.id)).accessToken);

    for (const path of ['/portal/me', `/portal/customers/${w.sol}/members`, `/portal/customers/${w.sol}/addresses`, `/portal/customers/${w.sol}/orders`]) {
      const body = JSON.stringify((await portal.get(path).expect(200)).body);
      expect(body).not.toMatch(/"(band|score|priority)"/);
    }
    await portal.get(`/customers/${w.sol}/priority`).expect(403);
  });

  it('computes each workspace once per local day', async () => {
    const w = await workspace();
    const computedAt = async () =>
      (await prisma.inTenant(w.id, (tx) => tx.customerPriority.findUniqueOrThrow({ where: { tenantId_customerId: { tenantId: w.id, customerId: w.sol } } }))).computedAt;

    await expect(priority.refreshDue(w.id, new Date())).resolves.toBe(true);
    const first = await computedAt();
    await expect(priority.refreshDue(w.id, new Date())).resolves.toBe(false);
    expect(await computedAt()).toEqual(first);

    await prisma.inTenant(w.id, (tx) => tx.customerPriority.updateMany({ data: { computedAt: yesterday(w) } }));
    await expect(priority.refreshDue(w.id, new Date())).resolves.toBe(true);
    expect((await computedAt()).getTime()).toBeGreaterThan(yesterday(w).getTime());
  });
});
