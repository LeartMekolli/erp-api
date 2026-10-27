import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import {
  customerOrderResponseSchema,
  portalShippingMethodsResponseSchema,
  priceChangedResponseSchema,
} from '../src/modules/orders/order-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Piece {
  label: string;
  stage: string | null;
  finished: boolean;
}
interface CustomerOrder {
  id: string;
  number: number;
  state: string;
  lines: { id: string; position: number; total: string; state: string; progress: { pieces: Piece[] } }[];
  lines_total: string;
  total: string;
}
interface Quote {
  id: string;
  total: string;
}

/**
 * Orders in the customer app (Orders spec, goals 1, 10 and 16; plan Task 6 and Review Focus 5): a
 * buyer orders from its own quotes and follows each line through the stages it may see. A customer
 * never sees a partner, a partner's cost, a margin or the staff breakdown.
 */
describe('portal: customers order and follow their orders', () => {
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

  /** A customer person written straight to the database, with a membership in a customer. */
  async function person(tenantId: string, customerId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind: 'customer' } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'customer', organisationId: customerId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /**
   * The priced cast part, published; `courier` at 9.90 and a switched-off `old_post`; tax at 19 % in
   * Germany; MetalWorks taking direct orders for the whole cast line; Luna Jewels with a buyer and a
   * viewer, and Sol Studio with a buyer.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;

    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    const old = (await staff.post('/orders/shipping-methods', { key: 'old_post', name: 'Old post', price: '3' }).expect(201))
      .body as { id: string };
    await staff.patch(`/orders/shipping-methods/${old.id}`, { active: false }).expect(200);
    await staff
      .put('/orders/tax-rates', {
        rates: [
          { country: null, region: null, percent: '0' },
          { country: 'DE', region: null, percent: '19' },
        ],
      })
      .expect(200);

    const metalworks = ((await staff.post('/partners', { name: 'MetalWorks Ltd', display_name: 'MetalWorks' }).expect(201)).body as {
      id: string;
    }).id;
    await staff
      .put(`/partners/${metalworks}/capabilities`, {
        capabilities: [printPattern, castingTree, casting, polishing, finalQc, packing].map((step_type_id) => ({
          step_type_id,
          capacity: 200,
          capacity_period: 'week',
        })),
      })
      .expect(200);
    await staff.put(`/partners/${metalworks}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
    await staff.post(`/partners/${metalworks}/prices/copy-from-workspace`).expect(200);
    await staff.patch(`/partners/${metalworks}/limits`, { accepts_direct_orders: true }).expect(200);
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
    await staff.put(`/partners/${metalworks}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
    await staff.post(`/partners/${metalworks}/approve`).expect(200);

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const sol = ((await staff.post('/customers', { name: 'Sol Studio' }).expect(201)).body as { id: string }).id;
    // Pay later, so an order starts at once instead of waiting for payment.
    for (const customer of [luna, sol]) {
      await staff.put(`/customers/${customer}/payment-terms`, { terms: 'pay_later' }).expect(200);
    }
    // Luna's own design: a customer may only quote with its own files.
    const design = (await measuredDesign(prisma, tenant.id, owner.id, { customerId: luna })).versionId;

    const configuration = (extra: object = {}) => ({
      product_id: cast.productId,
      options: { material: 'silver_925', finish: 'polished' },
      size: { scale: '1.5' },
      quantity: 10,
      file_version_id: design,
      ...extra,
    });
    const buyer = await person(tenant.id, luna, 'buyer');
    /** A quote Luna's buyer makes in the customer app, optionally at a workshop it picked. */
    const lunaQuote = async (extra: object = {}) =>
      ((await buyer.post(`/portal/customers/${luna}/quotes`, configuration(extra)).expect(201)).body as { quote: Quote }).quote;
    /** A quote staff make for Sol, with the workspace's own design. */
    const solQuote = async () =>
      ((await staff.post('/pricing/quotes', { ...configuration({ file_version_id: cast.versionId }), customer_id: sol }).expect(201))
        .body as { quote: Quote }).quote;

    return {
      id: tenant.id,
      staff,
      buyer,
      viewer: await person(tenant.id, luna, 'viewer'),
      solBuyer: await person(tenant.id, sol, 'buyer'),
      cast,
      metalworks,
      luna,
      sol,
      lunaQuote,
      solQuote,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
  const order = (tenant: Tenant, quoteIds: string[], by = tenant.buyer) =>
    by.post(`/portal/customers/${tenant.luna}/orders`, {
      lines: quoteIds.map((quote_id) => ({ quote_id })),
      address,
      shipping_method: 'courier',
    });
  const orderCount = (tenant: Tenant) => prisma.inTenant(tenant.id, (tx) => tx.order.count());
  /** Nothing a customer may not see: no partner, no partner's cost, no margin, no staff breakdown. */
  const expectNothingInternal = (body: unknown) => {
    const raw = JSON.stringify(body);
    for (const word of ['MetalWorks', 'partner', 'cost', 'margin', 'breakdown', 'group_id', 'customer']) {
      expect({ word, found: raw.includes(word) }).toEqual({ word, found: false });
    }
  };

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

  it('offers a customer only the shipping methods that are on', async () => {
    const tenant = await freshTenant();

    const methods = await tenant.viewer.get(`/portal/customers/${tenant.luna}/shipping-methods`).expect(200);
    expectDocumented(portalShippingMethodsResponseSchema, methods.body);
    expect(methods.body).toEqual({ data: [{ key: 'courier', name: 'Standard courier', price: '9.90' }] });
  });

  it('lets a buyer order from its quotes, then read and list the order with its progress', async () => {
    const tenant = await freshTenant();
    const quote = await tenant.lunaQuote();

    const placed = await order(tenant, [quote.id]).expect(201);
    expectDocumented(customerOrderResponseSchema, placed.body);
    const body = placed.body as CustomerOrder;
    expect(body).toMatchObject({ number: 1001, state: 'in_production' });
    expect(body.lines[0]).toMatchObject({ position: 0, total: quote.total, state: 'in_production' });
    // Every piece has started, before the first stage a customer may see.
    expect(body.lines[0].progress.pieces).toHaveLength(10);
    expect(body.lines[0].progress.pieces.every((piece) => piece.stage === null && !piece.finished)).toBe(true);

    // Staff see it as placed in the customer app.
    expect((await tenant.staff.get(`/orders/${body.id}`).expect(200)).body).toMatchObject({ channel: 'portal' });

    // The pieces reach casting: the customer sees the stage by its customer name.
    const group = ((await tenant.staff.get(`/orders/${body.id}`).expect(200)).body as { lines: { group_id: string }[] }).lines[0].group_id;
    const pieces = ((await tenant.staff.get(`/workflow/work-orders?group_id=${group}&limit=100`).expect(200)).body as { data: { id: string }[] })
      .data.map((piece) => piece.id);
    for (const step of ['print_pattern', 'casting_tree']) {
      await tenant.staff.post('/workflow/moves', { work_order_ids: pieces, at_step: step, kind: 'pass' }).expect(200);
    }

    const read = await tenant.viewer.get(`/portal/customers/${tenant.luna}/orders/${body.id}`).expect(200);
    expectDocumented(customerOrderResponseSchema, read.body);
    expect((read.body as CustomerOrder).lines[0].progress.pieces.map((piece) => piece.stage)).toEqual(Array(10).fill('Casting'));

    const listed = await tenant.viewer.get(`/portal/customers/${tenant.luna}/orders`).expect(200);
    expectDocumented(pageSchema(customerOrderResponseSchema), listed.body);
    expect((listed.body as { data: CustomerOrder[] }).data.map((one) => one.id)).toEqual([body.id]);
  });

  it('never shows a customer the workshop it picked, its cost or the margin', async () => {
    const tenant = await freshTenant();
    await tenant.staff.patch(`/customers/${tenant.luna}`, { may_pick_partner: true }).expect(200);
    const picked = await tenant.lunaQuote({ partner_id: tenant.metalworks });

    const placed = await order(tenant, [picked.id]).expect(201);
    const id = (placed.body as CustomerOrder).id;
    // Staff see the workshop holding the line; the customer never does.
    const staffView = (await tenant.staff.get(`/orders/${id}`).expect(200)).body as { lines: { partner: { id: string } | null }[] };
    expect(staffView.lines[0].partner?.id).toBe(tenant.metalworks);

    expectNothingInternal(placed.body);
    expectNothingInternal((await tenant.buyer.get(`/portal/customers/${tenant.luna}/orders/${id}`).expect(200)).body);
    expectNothingInternal((await tenant.buyer.get(`/portal/customers/${tenant.luna}/orders`).expect(200)).body);
  });

  it('answers a lapsed price in plain words, with the new quote to order with', async () => {
    const tenant = await freshTenant();
    await tenant.staff.patch(`/customers/${tenant.luna}`, { may_pick_partner: true }).expect(200);
    const picked = await tenant.lunaQuote({ partner_id: tenant.metalworks });
    await prisma.inTenant(tenant.id, (tx) => tx.quote.update({ where: { id: picked.id }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    await tenant.staff.post(`/partners/${tenant.metalworks}/suspend`).expect(200);

    const refused = await order(tenant, [picked.id]).expect(409);
    expectDocumented(priceChangedResponseSchema, refused.body);
    // The customer's wording, never the workshop's name or the pricing setup.
    expect((refused.body as { lines: { quote: Quote | null; reasons: { code: string; message: string }[] }[] }).lines).toEqual([
      expect.objectContaining({
        quote: null,
        reasons: [{ code: 'partner_unavailable', message: "This workshop can't take this job right now. Please pick another." }],
      }),
    ]);
    expect(JSON.stringify(refused.body)).not.toContain('MetalWorks');
    expect(await orderCount(tenant)).toBe(0);
  });

  it("keeps a customer's orders to its own buyers, and its quotes to its own orders", async () => {
    const tenant = await freshTenant();
    const quote = await tenant.lunaQuote();

    // A viewer reads but doesn't order.
    await order(tenant, [quote.id], tenant.viewer).expect(403);
    expect(await orderCount(tenant)).toBe(0);
    const id = ((await order(tenant, [quote.id]).expect(201)).body as CustomerOrder).id;

    // Sol's buyer can't read Luna's order, through Luna or through Sol.
    await tenant.solBuyer.get(`/portal/customers/${tenant.luna}/orders/${id}`).expect(404);
    await tenant.solBuyer.get(`/portal/customers/${tenant.sol}/orders/${id}`).expect(404);
    expect(((await tenant.solBuyer.get(`/portal/customers/${tenant.sol}/orders`).expect(200)).body as { data: unknown[] }).data).toEqual([]);

    // Luna's buyer can't order with Sol's quote, nor with an unknown one.
    const sols = await tenant.solQuote();
    const refused = await order(tenant, [sols.id]).expect(404);
    expect((refused.body as { errors: { path: string }[] }).errors[0].path).toBe('lines.0.quote_id');
    expect(await orderCount(tenant)).toBe(1);
    await tenant.buyer.get(`/portal/customers/${tenant.luna}/orders/not-an-id`).expect(400);
  });
});
