import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { claimResponseSchema, customerClaimResponseSchema } from '../src/modules/claims/claim-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Order {
  id: string;
  number: number;
  lines: { id: string; position: number; group_id: string }[];
}
interface Claim {
  id: string;
  number: number;
  order: { id: string; number: number };
  state: string;
  reason: { key: string; name: string };
  description: string;
  photos: { file_version_id: string }[];
  return: { requested_at: string; returned_at: string | null } | null;
  lines: { id: string; order_line: { id: string; position: number; product_name: string }; pieces: number; decision: object | null }[];
  shipment: object | null;
  created_at: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ADDRESS = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };

/**
 * Orders 3a, Task 1: the customer's people and staff open a claim on a delivered order, within the
 * workspace's window, naming lines, pieces, a reason and photos; staff may ask for the pieces back first.
 */
describe('claims: opening a claim', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none, so silver is at its fallback.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  /** The priced cast part; Luna Jewels (pay later) with a buyer, an admin and a viewer; Sol Studio with a buyer. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    // Staff without `order.write` (a member has it).
    const reader = await createTestUser(prisma, tenant.id, { roles: [] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);

    const customer = async (name: string) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      // Pay later, so an order starts at once instead of waiting for payment.
      await staff.put(`/customers/${id}/payment-terms`, { terms: 'pay_later' }).expect(200);
      return id;
    };
    const luna = await customer('Luna Jewels');
    const sol = await customer('Sol Studio');
    const person = async (customerId: string, role: string) => {
      const user = await createTestUser(prisma, tenant.id, { roles: [] });
      await prisma.inTenant(tenant.id, async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { kind: 'customer' } });
        await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'customer', organisationId: customerId, role } });
      });
      return as((await tokens.issueForUser(tenant.id, user.id)).accessToken);
    };

    const quote = async (customerId: string) =>
      ((
        await staff
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 3,
            file_version_id: cast.versionId,
            customer_id: customerId,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote.id;
    /** An order of `lines` lines of 3 pieces each, not yet made. */
    const place = async (lines = 1, customerId = luna) => {
      const quotes = [];
      for (let index = 0; index < lines; index += 1) quotes.push({ quote_id: await quote(customerId) });
      return (await staff.post('/orders', { customer_id: customerId, lines: quotes, address: ADDRESS, shipping_method: 'courier' }).expect(201)).body as Order;
    };
    /** Every piece finished directly (moving pieces through every step is Workflow's to test), then shipped. */
    const ship = async (order: Order) => {
      await prisma.inTenant(tenant.id, (tx) =>
        tx.workOrder.updateMany({ where: { groupId: { in: order.lines.map((line) => line.group_id) } }, data: { status: 'finished', currentStepId: null } }),
      );
      await staff.post(`/orders/${order.id}/ship`, { courier: 'DHL', tracking: 'JD0001' }).expect(200);
    };
    const deliver = async (order: Order) => {
      await ship(order);
      await staff.post(`/orders/${order.id}/deliver`).expect(200);
      return order;
    };
    /** A file version written to the database, uploaded; the customer's own when given one. */
    const photo = async (customerId?: string) => (await measuredDesign(prisma, tenant.id, owner.id, { measures: [], customerId })).versionId;

    return {
      id: tenant.id,
      staff,
      reader: as((await tokens.issueForUser(tenant.id, reader.id)).accessToken),
      luna,
      sol,
      buyer: await person(luna, 'buyer'),
      admin: await person(luna, 'admin'),
      viewer: await person(luna, 'viewer'),
      solBuyer: await person(sol, 'buyer'),
      place,
      ship,
      deliver,
      photo,
    };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const portalClaims = (w: Workspace, orderId: string) => `/portal/customers/${w.luna}/orders/${orderId}/claims`;
  const claimOf = (response: request.Response) => response.body as Claim;
  const raised = (w: Workspace, orderId: string, eventKey: string) =>
    prisma.inTenant(w.id, async (tx) =>
      (await tx.notification.findMany({ where: { eventKey, subjectType: 'order', subjectId: orderId }, orderBy: { id: 'asc' } })).map((row) => row.payload),
    );

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

  it('opens a claim on a delivered order, from the portal and by staff', async () => {
    const w = await workspace();
    const order = await w.deliver(await w.place(2));
    const lunasPhoto = await w.photo(w.luna);

    // A buyer claims two pieces of the first line as faulty, with a photo.
    const opened = await w.buyer
      .post(portalClaims(w, order.id), {
        reason: 'defect',
        description: 'Two rings have a crack at the shank.',
        lines: [{ position: 0, pieces: 2 }],
        photo_file_version_ids: [lunasPhoto],
      })
      .expect(201);
    expectDocumented(customerClaimResponseSchema, opened.body);
    const claim = claimOf(opened);
    expect(claim).toMatchObject({
      number: 1,
      order: { id: order.id, number: order.number },
      state: 'open',
      reason: { key: 'defect', name: 'Defect' },
      description: 'Two rings have a crack at the shank.',
      photos: [{ file_version_id: lunasPhoto }],
      return: null,
      lines: [{ order_line: { id: order.lines[0].id, position: 0, product_name: 'Custom cast part' }, pieces: 2, decision: null }],
      shipment: null,
    });
    // The customer never sees staff's side of a decision.
    expect(JSON.stringify(opened.body)).not.toMatch(/"fault"|"note"/);

    // Staff see it in the list, with the full shape.
    const listed = await w.staff.get('/claims?state=open').expect(200);
    expectDocumented(pageSchema(claimResponseSchema), listed.body);
    expect((listed.body as { data: Claim[] }).data.map((row) => row.id)).toEqual([claim.id]);
    const read = await w.staff.get(`/claims/${claim.id}`).expect(200);
    expectDocumented(claimResponseSchema, read.body);
    expect(claimOf(read).lines[0]).toMatchObject({ pieces: 2, decision: null });
    expect(((await w.staff.get(`/claims?customer_id=${w.sol}`).expect(200)).body as { data: Claim[] }).data).toEqual([]);

    // The customer's people follow it in the portal: the list, and one claim.
    const own = await w.viewer.get(`/portal/customers/${w.luna}/claims`).expect(200);
    expectDocumented(pageSchema(customerClaimResponseSchema), own.body);
    expect((own.body as { data: Claim[] }).data.map((row) => row.id)).toEqual([claim.id]);
    expectDocumented(customerClaimResponseSchema, (await w.viewer.get(`/portal/customers/${w.luna}/claims/${claim.id}`).expect(200)).body);
    // Never another customer's.
    await w.solBuyer.get(`/portal/customers/${w.sol}/claims/${claim.id}`).expect(404);

    // Staff open one for the second line, with a photo of the workspace's own, numbered next.
    const byStaff = await w.staff
      .post(`/orders/${order.id}/claims`, {
        reason: 'damaged_in_transit',
        description: 'The parcel arrived crushed.',
        lines: [{ position: 1, pieces: 3 }],
        photo_file_version_ids: [await w.photo()],
      })
      .expect(201);
    expectDocumented(claimResponseSchema, byStaff.body);
    expect(claimOf(byStaff)).toMatchObject({ number: 2, reason: { key: 'damaged_in_transit', name: 'Damaged in transit' }, lines: [{ pieces: 3 }] });

    // Staff hear of each new claim once.
    expect(await raised(w, order.id, 'claim.opened')).toEqual([
      { number: '1', order_number: String(order.number), customer_name: 'Luna Jewels' },
      { number: '2', order_number: String(order.number), customer_name: 'Luna Jewels' },
    ]);
  });

  it('refuses a claim before delivery, after the window, for more pieces than are left, and from a viewer', async () => {
    const w = await workspace();
    const claim = { reason: 'defect', description: 'Cracked.', lines: [{ position: 0, pieces: 1 }] };

    // Shipped but not delivered.
    const shipped = await w.place();
    await w.ship(shipped);
    await w.buyer.post(portalClaims(w, shipped.id), claim).expect(409);

    // Delivered more than the window ago: 30 days unless the workspace says otherwise.
    const old = await w.deliver(await w.place());
    await prisma.inTenant(w.id, (tx) => tx.order.update({ where: { id: old.id }, data: { deliveredAt: new Date(Date.now() - 31 * DAY_MS) } }));
    await w.buyer.post(portalClaims(w, old.id), claim).expect(409);
    await w.staff.put('/settings/orders.claims', { windowDays: 60, reasons: [{ key: 'defect', name: 'Defect' }] }).expect(200);
    await w.buyer.post(portalClaims(w, old.id), claim).expect(201);

    // Pieces: never more than the line has left to claim (3 pieces, 1 claimed).
    await w.buyer.post(portalClaims(w, old.id), { ...claim, lines: [{ position: 0, pieces: 3 }] }).expect(400);
    await w.buyer.post(portalClaims(w, old.id), { ...claim, lines: [{ position: 0, pieces: 0 }] }).expect(400);
    // A reason the workspace doesn't have (its reasons are now only `defect`), and a line the order doesn't have.
    await w.buyer.post(portalClaims(w, old.id), { ...claim, reason: 'wrong_size' }).expect(400);
    await w.buyer.post(portalClaims(w, old.id), { ...claim, lines: [{ position: 5, pieces: 1 }] }).expect(400);
    // A cancelled line can't be claimed.
    const partly = await w.place(2);
    await w.staff.post(`/orders/${partly.id}/cancel`, { reason: 'One is enough', lines: [1] }).expect(200);
    await w.deliver(partly);
    await w.staff.post(`/orders/${partly.id}/claims`, { ...claim, lines: [{ position: 1, pieces: 1 }] }).expect(400);

    // Photos: a customer attaches only its own; nothing is saved by a refusal.
    const fresh = await w.deliver(await w.place());
    for (const photo of [await w.photo(w.sol), await w.photo()]) {
      const refused = await w.buyer.post(portalClaims(w, fresh.id), { ...claim, photo_file_version_ids: [photo] }).expect(404);
      expect((refused.body as { errors: { path: string }[] }).errors[0].path).toBe('photo_file_version_ids.0');
    }

    // Who may claim: the customer's owner, admin and buyer, not a viewer; staff with `order.write`.
    await w.viewer.post(portalClaims(w, fresh.id), claim).expect(403);
    await w.solBuyer.post(`/portal/customers/${w.sol}/orders/${fresh.id}/claims`, claim).expect(404);
    await w.reader.post(`/orders/${fresh.id}/claims`, claim).expect(403);
    await w.admin.post(portalClaims(w, fresh.id), claim).expect(201);

    const left = await prisma.inTenant(w.id, (tx) => tx.claim.count({ where: { orderId: { in: [fresh.id, partly.id] } } }));
    expect(left).toBe(1);
  });

  it('asks for the pieces back and marks them received', async () => {
    const w = await workspace();
    const order = await w.deliver(await w.place());
    const claim = claimOf(
      await w.buyer.post(portalClaims(w, order.id), { reason: 'wrong_size', description: 'Too small.', lines: [{ position: 0, pieces: 1 }] }).expect(201),
    );

    // Not received before it was asked for.
    await w.staff.post(`/claims/${claim.id}/returned`).expect(409);

    const asked = await w.staff.post(`/claims/${claim.id}/return`).expect(200);
    expectDocumented(claimResponseSchema, asked.body);
    expect(claimOf(asked)).toMatchObject({ state: 'awaiting_return', return: { requested_at: expect.any(String), returned_at: null } });
    await w.staff.post(`/claims/${claim.id}/return`).expect(409);
    // The customer sees it waits for the pieces.
    const seen = await w.buyer.get(`/portal/customers/${w.luna}/claims/${claim.id}`).expect(200);
    expect(claimOf(seen).state).toBe('awaiting_return');

    const received = await w.staff.post(`/claims/${claim.id}/returned`).expect(200);
    expectDocumented(claimResponseSchema, received.body);
    expect(claimOf(received)).toMatchObject({ state: 'open', return: { requested_at: expect.any(String), returned_at: expect.any(String) } });
    await w.staff.post(`/claims/${claim.id}/returned`).expect(409);

    // Only staff who change orders, in their own workspace.
    const other = await workspace();
    await w.reader.post(`/claims/${claim.id}/return`).expect(403);
    await other.staff.post(`/claims/${claim.id}/return`).expect(404);
    await other.staff.get(`/claims/${claim.id}`).expect(404);
  });
});
