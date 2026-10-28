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
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { promisedDate } from '../src/modules/orders/dates';
import { orderResponseSchema, priceChangedResponseSchema } from '../src/modules/orders/order-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Line {
  id: string;
  position: number;
  product: { id: string; name: string };
  quantity: number;
  unit_price: string;
  total: string;
  state: string;
  group_id: string;
  partner: { id: string; name: string } | null;
}
interface Order {
  id: string;
  number: number;
  customer: { id: string; name: string };
  channel: string;
  state: string;
  promised_on: string;
  delivery_speed: string | null;
  address: object;
  shipping: {
    method: { key: string; name: string };
    price: string;
    courier: string | null;
    tracking: string | null;
    shipped_at: string | null;
    delivered_at: string | null;
  };
  lines: Line[];
  lines_total: string;
  tax: { percent: string; amount: string };
  total: string;
  currency: string;
  note: string | null;
  placed_at: string;
}
interface Quote {
  id: string;
  total: string;
}

/**
 * Placing an order (Orders spec, goals 1–4, 7, 8, 10, 11, 15, 17; plan Task 4 and Review Focus 1–3):
 * every line names the quote it was priced by; placing freezes the totals, numbers the order, works
 * out the promised date, and starts every line at once, at the workshop the customer picked or with
 * no partner (made in-house unless staff offer it). All of it, or nothing.
 */
describe('orders: placing an order', () => {
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

  /** A person written straight to the database, of `kind`, with a membership in an organisation. */
  async function person(tenantId: string, kind: 'customer' | 'partner', organisationId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: kind, organisationId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /**
   * The priced cast part, published; the standard speed promising 10 working days; `courier` at 9.90
   * and a switched-off `old_post`; tax at 19 % in Germany, 0 elsewhere; MetalWorks taking direct
   * orders for the whole cast line; Luna Jewels with a buyer, and Sol Studio.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;

    const speeds = (await staff.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] };
    const standard = speeds.data.find((speed) => speed.key === 'standard')!;
    await staff.patch(`/pricing/delivery-speeds/${standard.id}`, { working_days: 10 }).expect(200);

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
    const timezone = (await prisma.inTenant(tenant.id, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenant.id } }))).timezone;

    const configuration = (extra: object = {}) => ({
      product_id: cast.productId,
      options: { material: 'silver_925', finish: 'polished' },
      size: { scale: '1.5' },
      quantity: 10,
      ...extra,
    });
    /** A quote staff make for a customer, or an internal one without `customer_id`. */
    const staffQuote = async (extra: object = {}) =>
      ((await staff.post('/pricing/quotes', { ...configuration({ file_version_id: cast.versionId }), customer_id: luna, ...extra }).expect(201))
        .body as { quote: Quote }).quote;
    const buyer = await person(tenant.id, 'customer', luna, 'buyer');
    /** A quote Luna's buyer makes in the customer app, optionally at a workshop it picked. */
    const lunaQuote = async (extra: object = {}) =>
      ((await buyer.post(`/portal/customers/${luna}/quotes`, configuration({ file_version_id: design, ...extra })).expect(201)).body as {
        quote: Quote;
      }).quote;

    return {
      id: tenant.id,
      staff,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      buyer,
      cast,
      metalworks,
      luna,
      sol,
      timezone,
      staffQuote,
      lunaQuote,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
  const order = (tenant: Tenant, quoteIds: string[], extra: object = {}) =>
    tenant.staff.post('/orders', {
      customer_id: tenant.luna,
      lines: quoteIds.map((quote_id) => ({ quote_id })),
      address,
      shipping_method: 'courier',
      ...extra,
    });
  const counts = (tenant: Tenant) =>
    prisma.inTenant(tenant.id, async (tx) => ({
      orders: await tx.order.count(),
      groups: await tx.workOrderGroup.count(),
      assignments: await tx.jobAssignment.count(),
    }));
  const money = (value: Prisma.Decimal | string) => new Prisma.Decimal(value).toFixed(2);
  const lapse = (tenant: Tenant, quoteId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.quote.update({ where: { id: quoteId }, data: { expiresAt: new Date(Date.now() - 1000) } }));
  interface PriceChanged {
    code: string;
    lines: { position: number; previous_quote_id: string; quote: Quote | null; reasons: { code: string }[] }[];
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

  it('places an order from the quotes shown, freezes its totals and starts every line', async () => {
    const tenant = await freshTenant();
    const ten = await tenant.staffQuote();
    const two = await tenant.staffQuote({ quantity: 2 });

    const placed = await order(tenant, [ten.id, two.id], { note: 'Gift wrap, please' }).expect(201);
    expectDocumented(orderResponseSchema, placed.body);
    const body = placed.body as Order;

    // 19 % of the lines and the shipping together, rounded once.
    const linesTotal = new Prisma.Decimal(ten.total).plus(two.total);
    const tax = linesTotal.plus('9.90').times('0.19').toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    expect(body).toMatchObject({
      number: 1001,
      customer: { id: tenant.luna, name: 'Luna Jewels' },
      channel: 'staff',
      state: 'in_production',
      delivery_speed: 'standard',
      address,
      shipping: { method: { key: 'courier', name: 'Standard courier' }, price: '9.90', courier: null, tracking: null, shipped_at: null, delivered_at: null },
      lines_total: money(linesTotal),
      tax: { percent: '19', amount: money(tax) },
      total: money(linesTotal.plus('9.90').plus(tax)),
      note: 'Gift wrap, please',
    });
    // Ten working days on Monday to Friday, closing at 17:00: the workspace has no calendar of its own.
    expect(body.promised_on).toBe(
      promisedDate(new Date(body.placed_at), 10, { workingDays: [1, 2, 3, 4, 5], endHour: 17, closedDates: [] }, tenant.timezone),
    );

    // Each line is its quote, started at once with no partner: made in-house unless staff offer it.
    expect(body.lines.map((line) => [line.position, line.quantity, line.total, line.partner, line.state])).toEqual([
      [0, 10, ten.total, null, 'in_production'],
      [1, 2, two.total, null, 'in_production'],
    ]);
    for (const [index, quote] of [ten, two].entries()) {
      const line = body.lines[index];
      const group = await prisma.inTenant(tenant.id, (tx) =>
        tx.workOrderGroup.findUniqueOrThrow({ where: { id: line.group_id }, include: { workOrders: true } }),
      );
      expect(group).toMatchObject({ sourceType: 'order_line', sourceId: line.id, quoteId: quote.id, customerId: tenant.luna });
      expect(group.workOrders).toHaveLength(line.id === body.lines[0].id ? 10 : 2);
      expect(group.workOrders.every((piece) => piece.status === 'active')).toBe(true);
    }

    // Read back as placed; numbers count up per workspace.
    expect((await tenant.staff.get(`/orders/${body.id}`).expect(200)).body).toEqual(placed.body);
    const next = await order(tenant, [(await tenant.staffQuote()).id]).expect(201);
    expect((next.body as Order).number).toBe(1002);
    const elsewhere = await freshTenant();
    expect(((await order(elsewhere, [(await elsewhere.staffQuote()).id]).expect(201)).body as Order).number).toBe(1001);

    // Placing is audited.
    const audited = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.count({ where: { action: 'order.changed', subjectType: 'order', subjectId: body.id } }),
    );
    expect(audited).toBe(1);
  });

  it("starts a line at the workshop the customer picked, as that workshop's job at once", async () => {
    const tenant = await freshTenant();
    await tenant.staff.patch(`/customers/${tenant.luna}`, { may_pick_partner: true }).expect(200);
    const picked = await tenant.lunaQuote({ partner_id: tenant.metalworks });

    const placed = await order(tenant, [picked.id]).expect(201);
    const line = (placed.body as Order).lines[0];
    expect(line.partner).toEqual({ id: tenant.metalworks, name: 'MetalWorks Ltd' });
    const history = (await tenant.staff.get(`/partners/jobs/${line.group_id}`).expect(200)).body as {
      data: { partner: { id: string }; kind: string; status: string }[];
    };
    expect(history.data).toEqual([expect.objectContaining({ partner: expect.objectContaining({ id: tenant.metalworks }), kind: 'direct', status: 'accepted' })]);
  });

  it('refuses the whole order when a picked workshop can no longer take its line, and creates nothing', async () => {
    const tenant = await freshTenant();
    await tenant.staff.patch(`/customers/${tenant.luna}`, { may_pick_partner: true }).expect(200);
    const own = await tenant.staffQuote();
    const picked = await tenant.lunaQuote({ partner_id: tenant.metalworks });
    await tenant.staff.post(`/partners/${tenant.metalworks}/suspend`).expect(200);
    const before = await counts(tenant);

    const refused = await order(tenant, [own.id, picked.id]).expect(409);
    expect((refused.body as { errors: { path: string }[] }).errors[0].path).toBe('lines.1');
    // Not line 0's group either: all of it, or nothing.
    expect(await counts(tenant)).toEqual(before);
  });

  it("refuses quotes that aren't the customer's, aren't there, or are already ordered", async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const quote = await tenant.staffQuote();
    const before = await counts(tenant);

    // Another customer's quote, an internal quote, another workspace's quote, or no quote at all.
    await order(tenant, [(await tenant.staffQuote({ customer_id: tenant.sol })).id]).expect(404);
    await order(tenant, [(await tenant.staffQuote({ customer_id: undefined })).id]).expect(404);
    await order(tenant, [(await other.staffQuote()).id]).expect(404);
    await order(tenant, [newId()]).expect(404);
    // The same quote twice in one order.
    await order(tenant, [quote.id, quote.id]).expect(400);
    expect(await counts(tenant)).toEqual(before);

    await order(tenant, [quote.id]).expect(201);
    const again = await order(tenant, [quote.id]).expect(409);
    expect((again.body as { errors: { path: string }[] }).errors[0].path).toBe('lines.0');
  });

  it('lets only one of two identical orders through', async () => {
    const tenant = await freshTenant();
    const quote = await tenant.staffQuote();

    const responses = await Promise.all([order(tenant, [quote.id]), order(tenant, [quote.id])]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await counts(tenant)).toMatchObject({ orders: 1, groups: 1 });
  });

  it('refuses mixed delivery speeds, a shipping method that is off or unknown, and a bad address', async () => {
    const tenant = await freshTenant();
    // A customer's quote offers only the speeds of its plan (Payments 2): Starter gets rush.
    const plans = (await tenant.staff.get('/payments/plans').expect(200)).body as { data: { id: string; is_default: boolean }[] };
    const starter = plans.data.find((plan) => plan.is_default)!.id;
    await tenant.staff.patch(`/payments/plans/${starter}`, { speeds: [{ key: 'rush', surcharge_percent: null }] }).expect(200);
    const standard = await tenant.staffQuote();
    const rush = await tenant.staffQuote({ delivery_speed: 'rush' });
    const before = await counts(tenant);

    const mixed = await order(tenant, [standard.id, rush.id]).expect(400);
    expect((mixed.body as { errors: { path: string }[] }).errors[0].path).toBe('lines');
    await order(tenant, [standard.id], { shipping_method: 'old_post' }).expect(400);
    await order(tenant, [standard.id], { shipping_method: 'pigeon' }).expect(400);
    for (const bad of [{ ...address, country: 'de' }, { ...address, city: '' }, { ...address, extra: 'no' }]) {
      const response = await order(tenant, [standard.id], { address: bad });
      expect({ bad, status: response.status }).toEqual({ bad, status: 400 });
    }
    await order(tenant, []).expect(400);
    await tenant.staff.post('/orders', { lines: [{ quote_id: standard.id }], address, shipping_method: 'courier' }).expect(400);
    expect(await counts(tenant)).toEqual(before);
  });

  it('places an order with a lapsed quote whose price is unchanged, using a fresh quote', async () => {
    const tenant = await freshTenant();
    const lapsed = await tenant.staffQuote();
    await lapse(tenant, lapsed.id);

    const placed = await order(tenant, [lapsed.id]).expect(201);
    const line = (placed.body as Order).lines[0];
    expect(line.total).toBe(lapsed.total);
    // A new quote, at the same price; the lapsed one stays unordered.
    const ordered = await prisma.inTenant(tenant.id, (tx) => tx.orderLine.findUniqueOrThrow({ where: { id: line.id } }));
    expect(ordered.quoteId).not.toBe(lapsed.id);
    const [old, fresh] = await prisma.inTenant(tenant.id, (tx) =>
      Promise.all([lapsed.id, ordered.quoteId].map((id) => tx.quote.findUniqueOrThrow({ where: { id }, include: { orderLine: true } }))),
    );
    // Priced from the same inputs, for the same customer.
    expect(fresh).toMatchObject({ customerId: tenant.luna, productId: old.productId, quantity: old.quantity, inputs: old.inputs });
    expect(fresh.total.equals(old.total)).toBe(true);
    expect(fresh.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(old.orderLine).toBeNull();
  });

  it('refuses a lapsed quote whose price changed, with the new price to confirm', async () => {
    const tenant = await freshTenant();
    const lapsed = await tenant.staffQuote();
    await lapse(tenant, lapsed.id);
    // Silver costs more since the quote was shown.
    await tenant.staff.put(`/catalog/materials/${tenant.cast.silver}/price-override`, { price: '1.25', reason: 'supplier' }).expect(200);
    const before = await counts(tenant);

    const refused = await order(tenant, [lapsed.id]).expect(409);
    expectDocumented(priceChangedResponseSchema, refused.body);
    const changed = refused.body as PriceChanged;
    expect(changed.code).toBe('price_changed');
    expect(changed.lines).toEqual([
      expect.objectContaining({ position: 0, previous_quote_id: lapsed.id, reasons: [], quote: expect.objectContaining({ id: expect.any(String) }) }),
    ]);
    const confirmed = changed.lines[0].quote!;
    expect(confirmed.total).not.toBe(lapsed.total);
    // Nothing placed; the new quote was saved, so it can be ordered.
    expect(await counts(tenant)).toEqual(before);

    const placed = await order(tenant, [confirmed.id]).expect(201);
    expect((placed.body as Order).lines_total).toBe(money(confirmed.total));
  });

  it('answers a lapsed picked-workshop quote the workshop can no longer take', async () => {
    const tenant = await freshTenant();
    await tenant.staff.patch(`/customers/${tenant.luna}`, { may_pick_partner: true }).expect(200);
    const picked = await tenant.lunaQuote({ partner_id: tenant.metalworks });
    await lapse(tenant, picked.id);
    await tenant.staff.post(`/partners/${tenant.metalworks}/suspend`).expect(200);

    const refused = await order(tenant, [picked.id]).expect(409);
    const changed = refused.body as PriceChanged;
    expect(changed.lines[0]).toMatchObject({ position: 0, previous_quote_id: picked.id, quote: null });
    expect(changed.lines[0].reasons.map((reason) => reason.code)).toEqual(['partner_unavailable']);
    expect(await counts(tenant)).toMatchObject({ orders: 0 });
  });

  it('lets staff who may order place and read orders, and keeps orders to the workspace', async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();

    // Members place orders; customer people use the customer app, never the staff routes.
    const byMember = await tenant.member
      .post('/orders', { customer_id: tenant.luna, lines: [{ quote_id: (await tenant.staffQuote()).id }], address, shipping_method: 'courier' })
      .expect(201);
    await tenant.buyer
      .post('/orders', { customer_id: tenant.luna, lines: [{ quote_id: (await tenant.staffQuote()).id }], address, shipping_method: 'courier' })
      .expect(403);
    const second = await order(tenant, [(await tenant.staffQuote()).id]).expect(201);
    await order(tenant, [(await tenant.staffQuote({ customer_id: tenant.sol })).id], { customer_id: tenant.sol }).expect(201);

    // Newest first, optionally for one customer, a page at a time.
    const listed = await tenant.member.get(`/orders?customer_id=${tenant.luna}`).expect(200);
    expectDocumented(pageSchema(orderResponseSchema), listed.body);
    expect((listed.body as { data: Order[] }).data.map((one) => one.id)).toEqual([(second.body as Order).id, (byMember.body as Order).id]);
    const page = (await tenant.member.get('/orders?limit=1').expect(200)).body as { data: Order[]; next_cursor: string | null };
    expect(page.data).toHaveLength(1);
    expect(page.next_cursor).toEqual(expect.any(String));

    // Another workspace's order isn't there.
    await other.staff.get(`/orders/${(second.body as Order).id}`).expect(404);
    expect((await other.staff.get('/orders').expect(200)).body).toMatchObject({ data: [] });
    await tenant.staff.get('/orders/not-an-id').expect(400);
    await tenant.staff.get(`/orders/${newId()}`).expect(404);
    // Placing for another workspace's customer.
    await other.staff
      .post('/orders', { customer_id: tenant.luna, lines: [{ quote_id: (await other.staffQuote()).id }], address, shipping_method: 'courier' })
      .expect(404);
  });
});
