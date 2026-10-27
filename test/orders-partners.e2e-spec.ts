import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { measuredDesign } from './catalog-fixtures';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Line {
  position: number;
  group_id: string;
  partner: { id: string; name: string } | null;
}
interface Order {
  id: string;
  lines: Line[];
}
interface Refusal {
  detail: string;
  errors?: { path: string; message: string }[];
}

const ONE_PARTNER = 'Every line of this order goes to one partner';

/**
 * One partner per order (Orders spec, goal 3; Partners P4; plan Task 9): with the workspace setting
 * `partners.routing.splitOrderLines` false, every line of an order that goes to a partner goes to the
 * same one. Offers, moves and the customer's picks are refused otherwise; lines made in-house, and
 * lines no partner holds any more, don't count. A workspace that never set it may split.
 */
describe('orders: the lines of one order and their partners', () => {
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
   * The priced cast part, published; `courier`; CastCo and MetalWorks, each able to make the whole
   * cast line and taking direct orders, each with a member; Luna Jewels, who may pick a workshop,
   * with a buyer.
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
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;

    /** An approved workshop for the whole cast line, taking direct orders, with a member. */
    const workshop = async (name: string) => {
      const id = ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
      await staff
        .put(`/partners/${id}/capabilities`, {
          capabilities: [printPattern, castingTree, casting, polishing, finalQc, packing].map((step_type_id) => ({
            step_type_id,
            capacity: 200,
            capacity_period: 'week',
          })),
        })
        .expect(200);
      await staff.put(`/partners/${id}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
      await staff.post(`/partners/${id}/prices/copy-from-workspace`).expect(200);
      await staff.patch(`/partners/${id}/limits`, { accepts_direct_orders: true }).expect(200);
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return { id, person: await person(tenant.id, 'partner', id, 'member') };
    };
    const castco = await workshop('CastCo');
    const metalworks = await workshop('MetalWorks');

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    await staff.patch(`/customers/${luna}`, { may_pick_partner: true }).expect(200);
    // Luna's own design: a customer may only quote with its own files.
    const design = (await measuredDesign(prisma, tenant.id, owner.id, { customerId: luna })).versionId;
    const buyer = await person(tenant.id, 'customer', luna, 'buyer');

    const configuration = (extra: object = {}) => ({
      product_id: cast.productId,
      options: { material: 'silver_925', finish: 'polished' },
      size: { scale: '1.5' },
      quantity: 10,
      ...extra,
    });
    /** A quote staff make for Luna, at the workspace's own prices. */
    const staffQuote = async (quantity = 10) =>
      ((await staff.post('/pricing/quotes', { ...configuration({ quantity, file_version_id: cast.versionId }), customer_id: luna }).expect(201))
        .body as { quote: { id: string } }).quote;
    /** A quote Luna's buyer makes in the customer app, at the workshop it picked. */
    const pickedQuote = async (partnerId: string) =>
      ((await buyer.post(`/portal/customers/${luna}/quotes`, configuration({ file_version_id: design, partner_id: partnerId })).expect(201))
        .body as { quote: { id: string } }).quote;

    return { id: tenant.id, staff, buyer, castco, metalworks, luna, staffQuote, pickedQuote };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
  /** An order of Luna's, placed by staff, one line per quote. */
  const order = (tenant: Tenant, quoteIds: string[]) =>
    tenant.staff.post('/orders', {
      customer_id: tenant.luna,
      lines: quoteIds.map((quote_id) => ({ quote_id })),
      address,
      shipping_method: 'courier',
    });
  /** An order of Luna's at the workspace's own prices, one line per quantity, no line with a partner yet. */
  const placeOrder = async (tenant: Tenant, quantities: number[]) => {
    const quoteIds = [];
    for (const quantity of quantities) quoteIds.push((await tenant.staffQuote(quantity)).id);
    return (await order(tenant, quoteIds).expect(201)).body as Order;
  };
  /** Whether the lines of one order may go to different partners. */
  const split = (tenant: Tenant, splitOrderLines: boolean) =>
    tenant.staff.put('/settings/partners.routing', { offerHours: 24, splitOrderLines }).expect(200);
  const offer = (tenant: Tenant, groupId: string, partnerId: string) =>
    tenant.staff.post(`/partners/jobs/${groupId}/offer`, { partner_id: partnerId });
  /** Offers the job to the workshop, which takes it. */
  const handTo = async (tenant: Tenant, groupId: string, workshop: Tenant['castco']) => {
    await offer(tenant, groupId, workshop.id).expect(201);
    await workshop.person.post(`/partner-portal/partners/${workshop.id}/jobs/${groupId}/accept`).expect(200);
  };
  const history = async (tenant: Tenant, groupId: string) =>
    ((await tenant.staff.get(`/partners/jobs/${groupId}`).expect(200)).body as { data: { partner: { id: string }; status: string }[] }).data.map(
      (row) => [row.partner.id, row.status],
    );
  const counts = (tenant: Tenant) =>
    prisma.inTenant(tenant.id, async (tx) => ({
      orders: await tx.order.count(),
      groups: await tx.workOrderGroup.count(),
      assignments: await tx.jobAssignment.count(),
    }));

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

  it("offers a line only to the partner holding the order's other lines", async () => {
    const tenant = await freshTenant();
    await split(tenant, false);
    const [first, second] = (await placeOrder(tenant, [10, 2])).lines;
    await offer(tenant, first.group_id, tenant.castco.id).expect(201);

    // An open offer holds the line, as an accepted job does.
    const refused = await offer(tenant, second.group_id, tenant.metalworks.id).expect(409);
    expect((refused.body as Refusal).detail).toBe(ONE_PARTNER);
    expect(await history(tenant, second.group_id)).toEqual([]);

    await offer(tenant, second.group_id, tenant.castco.id).expect(201);
    expect(await history(tenant, second.group_id)).toEqual([[tenant.castco.id, 'offered']]);
  });

  it('refuses moving one line of an order to another partner, but moves a lone line', async () => {
    const tenant = await freshTenant();
    await split(tenant, false);
    const [first, second] = (await placeOrder(tenant, [10, 2])).lines;
    await handTo(tenant, first.group_id, tenant.castco);
    await handTo(tenant, second.group_id, tenant.castco);

    const refused = await tenant.staff.post(`/partners/jobs/${second.group_id}/reassign`, { partner_id: tenant.metalworks.id }).expect(409);
    expect((refused.body as Refusal).detail).toBe(ONE_PARTNER);
    expect(await history(tenant, second.group_id)).toEqual([[tenant.castco.id, 'accepted']]);

    // An order of one line has no other line to keep with.
    const [lone] = (await placeOrder(tenant, [3])).lines;
    await handTo(tenant, lone.group_id, tenant.castco);
    await tenant.staff.post(`/partners/jobs/${lone.group_id}/reassign`, { partner_id: tenant.metalworks.id }).expect(201);
  });

  it('leaves out lines made in-house, cancelled, or whose offer lapsed', async () => {
    const tenant = await freshTenant();
    await split(tenant, false);
    const placed = await placeOrder(tenant, [10, 2, 1, 1]);
    const [inHouse, cancelled, lapsed, last] = placed.lines;

    // Line 0 stays in-house: it doesn't stop line 1 going to CastCo.
    await handTo(tenant, cancelled.group_id, tenant.castco);
    expect(await history(tenant, inHouse.group_id)).toEqual([]);

    // Once line 1 is cancelled CastCo holds nothing of the order: line 2 may go to MetalWorks.
    await tenant.staff.post(`/orders/${placed.id}/cancel`, { reason: 'Customer asked', lines: [1] }).expect(200);
    await offer(tenant, lapsed.group_id, tenant.metalworks.id).expect(201);

    // An offer past its deadline holds nothing, whether or not the expiry run has been by.
    await prisma.inTenant(tenant.id, (tx) =>
      tx.jobAssignment.updateMany({ where: { groupId: lapsed.group_id }, data: { expiresAt: new Date(Date.now() - 1000) } }),
    );
    await offer(tenant, last.group_id, tenant.castco.id).expect(201);
  });

  it('refuses an order whose lines were picked at different workshops, and creates nothing', async () => {
    const tenant = await freshTenant();
    await split(tenant, false);
    const atCastco = await tenant.pickedQuote(tenant.castco.id);
    const atMetalworks = await tenant.pickedQuote(tenant.metalworks.id);
    const before = await counts(tenant);

    const refused = await order(tenant, [atCastco.id, atMetalworks.id]).expect(409);
    expect((refused.body as Refusal).errors).toEqual([{ path: 'lines.1', message: ONE_PARTNER }]);
    // From the customer app too: placing is the same rule for both.
    const portalBody = { lines: [{ quote_id: atCastco.id }, { quote_id: atMetalworks.id }], address, shipping_method: 'courier' };
    const fromPortal = await tenant.buyer.post(`/portal/customers/${tenant.luna}/orders`, portalBody).expect(409);
    expect((fromPortal.body as Refusal).errors).toEqual([{ path: 'lines.1', message: ONE_PARTNER }]);
    expect(await counts(tenant)).toEqual(before);

    // Two lines at one workshop, or a picked line beside an in-house one, are one partner.
    const both = (await order(tenant, [atCastco.id, (await tenant.pickedQuote(tenant.castco.id)).id]).expect(201)).body as Order;
    expect(both.lines.map((line) => line.partner?.id)).toEqual([tenant.castco.id, tenant.castco.id]);
    const mixed = (await order(tenant, [atMetalworks.id, (await tenant.staffQuote()).id]).expect(201)).body as Order;
    expect(mixed.lines.map((line) => line.partner?.id ?? null)).toEqual([tenant.metalworks.id, null]);

    // A picked workshop's direct job holds its order like any other: the in-house line can't go elsewhere.
    const refusedOffer = await offer(tenant, mixed.lines[1].group_id, tenant.castco.id).expect(409);
    expect((refusedOffer.body as Refusal).detail).toBe(ONE_PARTNER);
    await offer(tenant, mixed.lines[1].group_id, tenant.metalworks.id).expect(201);
  });

  it('lets only one of two offers at once of two lines to different partners through', async () => {
    const tenant = await freshTenant();
    await split(tenant, false);
    const [first, second] = (await placeOrder(tenant, [10, 2])).lines;

    const answers = await Promise.all([
      offer(tenant, first.group_id, tenant.castco.id),
      offer(tenant, second.group_id, tenant.metalworks.id),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
    const held = await prisma.inTenant(tenant.id, (tx) =>
      tx.jobAssignment.findMany({ where: { groupId: { in: [first.group_id, second.group_id] } }, select: { partnerId: true } }),
    );
    expect(held).toHaveLength(1);
  });

  it('lets the lines go to different partners when the workspace allows it, or never set it', async () => {
    for (const setting of [undefined, true]) {
      const tenant = await freshTenant();
      if (setting !== undefined) await split(tenant, setting);

      const atCastco = await tenant.pickedQuote(tenant.castco.id);
      const atMetalworks = await tenant.pickedQuote(tenant.metalworks.id);
      const picked = (await order(tenant, [atCastco.id, atMetalworks.id]).expect(201)).body as Order;
      expect(picked.lines.map((line) => line.partner?.id)).toEqual([tenant.castco.id, tenant.metalworks.id]);

      const [first, second] = (await placeOrder(tenant, [10, 2])).lines;
      await handTo(tenant, first.group_id, tenant.castco);
      await handTo(tenant, second.group_id, tenant.castco);
      await tenant.staff.post(`/partners/jobs/${second.group_id}/reassign`, { partner_id: tenant.metalworks.id }).expect(201);
    }
  });
});
