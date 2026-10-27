import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { customerOrderResponseSchema, orderResponseSchema } from '../src/modules/orders/order-response';
import { pricedAssembly } from './assembly-fixtures';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Part {
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
interface Line {
  id: string;
  position: number;
  quantity: number;
  total: string;
  state: string;
  group_id: string;
  partner: { id: string } | null;
  parts: Part[];
}
interface Order {
  id: string;
  state: string;
  lines_total: string;
  lines: Line[];
}
interface Quote {
  id: string;
  total: string;
}

/**
 * Ordering a product made of parts (Orders spec, goal 6; B5; Orders 2 plan, Task 3): one line, one
 * sub-line per part, each started as its own group under the line's. The set is put together
 * in-house; its parts go to partners like any line, outside the one-partner rule.
 */
describe('orders: assemblies', () => {
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
   * The pendant set (`pricedAssembly`), `courier`, Luna Jewels with a buyer, and MetalWorks and
   * CastCo, each able to make the pendant and the bail, each with a member.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const set = await pricedAssembly(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    const { printPattern, castingTree, casting, polishing } = set.cast.steps;
    const { finalQc, packing } = set.cast.workflow.notPriced;
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;

    const workshop = async (name: string) => {
      const id = ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
      await staff
        .put(`/partners/${id}/capabilities`, {
          capabilities: [printPattern, castingTree, casting, polishing, set.steps.print, finalQc, packing].map((step_type_id) => ({
            step_type_id,
            capacity: 500,
            capacity_period: 'week',
          })),
        })
        .expect(200);
      await staff.put(`/partners/${id}/offerings`, { option_value_ids: [set.cast.v.silver, set.cast.v.polished] }).expect(200);
      await staff.post(`/partners/${id}/prices/copy-from-workspace`).expect(200);
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return { id, person: await person(tenant.id, 'partner', id, 'member') };
    };

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    return {
      id: tenant.id,
      staff,
      buyer: await person(tenant.id, 'customer', luna, 'buyer'),
      luna,
      metalworks: await workshop('MetalWorks'),
      castco: await workshop('CastCo'),
      ...set,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
  /** A quote staff make for Luna: 3 silver polished pendant sets, unless told otherwise. */
  const setQuote = async (tenant: Tenant, extra: object = {}) =>
    ((
      await tenant.staff
        .post('/pricing/quotes', {
          product_id: tenant.set,
          options: { material: 'silver_925', finish: 'polished' },
          quantity: 3,
          customer_id: tenant.luna,
          ...extra,
        })
        .expect(201)
    ).body as { quote: Quote }).quote;
  /** A plain cast part for Luna, to sit beside the set on one order. */
  const castQuote = async (tenant: Tenant) =>
    ((
      await tenant.staff
        .post('/pricing/quotes', {
          product_id: tenant.cast.productId,
          options: { material: 'silver_925', finish: 'polished' },
          size: { scale: '1.5' },
          quantity: 2,
          file_version_id: tenant.cast.versionId,
          customer_id: tenant.luna,
        })
        .expect(201)
    ).body as { quote: Quote }).quote;
  const order = (tenant: Tenant, quoteIds: string[]) =>
    tenant.staff.post('/orders', { customer_id: tenant.luna, lines: quoteIds.map((quote_id) => ({ quote_id })), address, shipping_method: 'courier' });
  const staffView = async (tenant: Tenant, id: string) => (await tenant.staff.get(`/orders/${id}`).expect(200)).body as Order;
  const group = (tenant: Tenant, id: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.workOrderGroup.findUniqueOrThrow({ where: { id }, include: { workOrders: { include: { currentStep: true } } } }));
  const handTo = async (tenant: Tenant, groupId: string, workshop: Tenant['castco']) => {
    await tenant.staff.post(`/partners/jobs/${groupId}/offer`, { partner_id: workshop.id }).expect(201);
    await workshop.person.post(`/partner-portal/partners/${workshop.id}/jobs/${groupId}/accept`).expect(200);
  };
  const staffQuoteView = async (tenant: Tenant, id: string) =>
    (await tenant.staff.get(`/pricing/quotes/${id}`).expect(200)).body as { breakdown: { parts: { quote_id: string; total: string }[] } };

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

  it('orders a set as one line with a sub-line per part, and starts every group', async () => {
    const tenant = await freshTenant();
    const quote = await setQuote(tenant);
    const parts = (await staffQuoteView(tenant, quote.id)).breakdown.parts;

    const placed = await order(tenant, [quote.id]).expect(201);
    expectDocumented(orderResponseSchema, placed.body);
    const body = placed.body as Order;
    // The line is priced once, at the set's quote: the parts are inside it.
    expect(body.lines_total).toBe(quote.total);
    expect(body.lines).toHaveLength(1);
    const [line] = body.lines;
    expect(line).toMatchObject({ position: 0, quantity: 3, total: quote.total, state: 'in_production', partner: null });
    expect(line.parts.map((part) => [part.position, part.product.id, part.quantity, part.total, part.state, part.partner])).toEqual([
      [0, tenant.pendant, 3, parts[0].total, 'in_production', null],
      [1, tenant.bail, 6, parts[1].total, 'in_production', null],
    ]);

    // The line's pieces wait at the set's first step; each part is its own group, under the line's.
    const own = await group(tenant, line.group_id);
    expect(own).toMatchObject({ sourceType: 'order_line', sourceId: line.id, quoteId: quote.id, parentGroupId: null });
    expect(own.workOrders.map((piece) => piece.currentStep?.key)).toEqual(['assembly', 'assembly', 'assembly']);
    for (const [index, part] of line.parts.entries()) {
      const started = await group(tenant, part.group_id);
      expect(started).toMatchObject({ sourceType: 'order_line', sourceId: part.id, quoteId: parts[index].quote_id, parentGroupId: line.group_id });
      expect(started.workOrders).toHaveLength(part.quantity);
    }
    // Read back as placed.
    expect(await staffView(tenant, body.id)).toEqual(placed.body);
  });

  it("shows the customer one price per line and each part's progress, never a partner or a part's price", async () => {
    const tenant = await freshTenant();
    const placed = (await order(tenant, [(await setQuote(tenant)).id]).expect(201)).body as Order;
    await handTo(tenant, placed.lines[0].parts[0].group_id, tenant.metalworks);

    const seen = await tenant.buyer.get(`/portal/customers/${tenant.luna}/orders/${placed.id}`).expect(200);
    expectDocumented(customerOrderResponseSchema, seen.body);
    const [line] = (seen.body as { lines: { total: string; parts: object[] }[] }).lines;
    expect(line.total).toBe(placed.lines[0].total);
    expect(line.parts).toEqual([
      { position: 0, product: { id: tenant.pendant, name: 'Pendant' }, quantity: 3, state: 'in_production', progress: expect.any(Object) },
      { position: 1, product: { id: tenant.bail, name: 'Bail' }, quantity: 6, state: 'in_production', progress: expect.any(Object) },
    ]);
    for (const secret of ['MetalWorks', 'partner', 'cost', 'margin', 'group_id', placed.lines[0].parts[0].total, placed.lines[0].parts[1].total]) {
      expect({ secret, found: seen.text.includes(secret) }).toEqual({ secret, found: false });
    }
  });

  it("refuses a part's quote ordered on its own", async () => {
    const tenant = await freshTenant();
    const [pendant] = (await staffQuoteView(tenant, (await setQuote(tenant)).id)).breakdown.parts;

    const refused = await order(tenant, [pendant.quote_id]).expect(404);
    expect((refused.body as { errors: { path: string }[] }).errors[0].path).toBe('lines.0.quote_id');
  });

  it('cancels a set line with its parts, and owes a partner that took a part what staff set', async () => {
    const tenant = await freshTenant();
    const placed = (await order(tenant, [(await setQuote(tenant)).id]).expect(201)).body as Order;
    const [line] = placed.lines;
    await handTo(tenant, line.parts[0].group_id, tenant.metalworks);
    // What a part's partner is owed names the part, and only one the line has.
    await tenant.staff
      .post(`/orders/${placed.id}/cancel`, { reason: 'Nope', partner_owed: [{ position: 0, part: 5, amount: '1.00', reason: 'x' }] })
      .expect(400);

    const cancelled = await tenant.staff
      .post(`/orders/${placed.id}/cancel`, { reason: 'Customer asked', partner_owed: [{ position: 0, part: 0, amount: '10.00', reason: 'Patterns printed' }] })
      .expect(200);
    const body = cancelled.body as Order;
    expect([body.state, body.lines[0].state, ...body.lines[0].parts.map((part) => part.state)]).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled']);
    for (const groupId of [line.group_id, ...line.parts.map((part) => part.group_id)]) {
      expect((await group(tenant, groupId)).workOrders.every((piece) => piece.status === 'cancelled')).toBe(true);
    }
    const owed = (await tenant.staff.get(`/partners/${tenant.metalworks.id}/owed`).expect(200)).body as {
      jobs: { group_id: string; state: string; amount: string }[];
    };
    expect(owed.jobs.find((job) => job.group_id === line.parts[0].group_id)).toMatchObject({ state: 'owed', amount: '10.00' });
  });

  it('refuses the customer cancelling once a piece of a part has moved', async () => {
    const tenant = await freshTenant();
    const placed = (await order(tenant, [(await setQuote(tenant)).id]).expect(201)).body as Order;
    const [first] = (await group(tenant, placed.lines[0].parts[0].group_id)).workOrders;
    await tenant.staff.post('/workflow/moves', { work_order_ids: [first.id], at_step: 'print_pattern', kind: 'pass' }).expect(200);

    await tenant.buyer.post(`/portal/customers/${tenant.luna}/orders/${placed.id}/cancel`, { reason: 'Changed my mind' }).expect(409);
  });

  it('keeps the set in-house, and its parts out of the one-partner rule', async () => {
    const tenant = await freshTenant();
    await tenant.staff.put('/settings/partners.routing', { offerHours: 24, splitOrderLines: false }).expect(200);
    const placed = (await order(tenant, [(await setQuote(tenant)).id, (await castQuote(tenant)).id]).expect(201)).body as Order;
    const [set, plain] = placed.lines;
    expect(plain.parts).toEqual([]);

    // The set is put together by the workspace: no partner may have it.
    const refused = await tenant.staff.post(`/partners/jobs/${set.group_id}/offer`, { partner_id: tenant.metalworks.id }).expect(409);
    expect(JSON.stringify(refused.body)).toContain('An assembly is put together in-house');
    const eligible = (await tenant.staff.get(`/partners/eligible?group_id=${set.group_id}`).expect(200)).body as {
      data: unknown[];
      ineligible: { reasons: string[] }[];
    };
    expect(eligible.data).toEqual([]);
    expect(eligible.ineligible.every((row) => row.reasons.includes('An assembly is put together in-house'))).toBe(true);

    // Its parts go to different partners, and don't hold the order for either.
    await tenant.staff.post(`/partners/jobs/${set.parts[0].group_id}/offer`, { partner_id: tenant.metalworks.id }).expect(201);
    await tenant.staff.post(`/partners/jobs/${set.parts[1].group_id}/offer`, { partner_id: tenant.castco.id }).expect(201);
    await tenant.staff.post(`/partners/jobs/${plain.group_id}/offer`, { partner_id: tenant.castco.id }).expect(201);
    const view = await staffView(tenant, placed.id);
    expect(view.lines[0].parts.map((part) => part.partner?.id)).toEqual([tenant.metalworks.id, tenant.castco.id]);
  });

  /** Parts of a set are made elsewhere in the workflow; the tests only need them in a state, so they are set directly. */
  const finish = (tenant: Tenant, groupId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.workOrder.updateMany({ where: { groupId, status: 'active' }, data: { status: 'finished', currentStepId: null } }));
  const refused = (body: unknown) => body as { detail: string; errors: { path: string; message: string }[] };

  it('holds the set at its first step until every part is ready', async () => {
    const tenant = await freshTenant();
    const placed = (await order(tenant, [(await setQuote(tenant)).id]).expect(201)).body as Order;
    const [line] = placed.lines;
    const [piece, ...others] = (await group(tenant, line.group_id)).workOrders;
    const ids = [piece.id, others[0].id];
    const crack = tenant.cast.workflow.defects.crack;

    // With the parts at their first steps: a pass, a scrap and a correction to a later step are all held.
    const pass = await tenant.staff.post('/workflow/moves', { work_order_ids: ids, at_step: 'assembly', kind: 'pass' }).expect(409);
    expect(refused(pass.body)).toMatchObject({ detail: 'The parts are not ready yet', errors: [{ path: 'work_order_ids.0' }, { path: 'work_order_ids.1' }] });
    await tenant.staff.post('/workflow/moves', { work_order_ids: [piece.id], at_step: 'assembly', kind: 'fail', defect_id: crack }).expect(409);
    await tenant.staff.post('/workflow/moves', { work_order_ids: [piece.id], kind: 'correction', to_step: 'packing', comment: 'Skip ahead' }).expect(409);

    // A piece that stays at the first step isn't held: one found at packing goes back to assembly.
    const { workflowVersionId } = await group(tenant, line.group_id);
    const packing = (await prisma.inTenant(tenant.id, (tx) => tx.workflowStep.findFirstOrThrow({ where: { key: 'packing', versionId: workflowVersionId } }))).id;
    await prisma.inTenant(tenant.id, (tx) => tx.workOrder.update({ where: { id: piece.id }, data: { currentStepId: packing } }));
    await tenant.staff.post('/workflow/moves', { work_order_ids: [piece.id], kind: 'correction', to_step: 'assembly', comment: 'Back to assembly' }).expect(200);

    // The pendant ready, the bail not: still held.
    await finish(tenant, line.parts[0].group_id);
    await tenant.staff.post('/workflow/moves', { work_order_ids: ids, at_step: 'assembly', kind: 'pass' }).expect(409);
    expect((await group(tenant, line.group_id)).workOrders.every((row) => row.currentStep?.key === 'assembly')).toBe(true);
  });

  it('releases the hold once every part is ready, a remade piece included', async () => {
    const tenant = await freshTenant();
    const placed = (await order(tenant, [(await setQuote(tenant)).id]).expect(201)).body as Order;
    const [line] = placed.lines;
    const setPieces = (await group(tenant, line.group_id)).workOrders.map((piece) => piece.id);
    await finish(tenant, line.parts[0].group_id);

    // One bail piece is scrapped and remade, the rest finished: the remade piece keeps the hold.
    const [scrapped] = (await group(tenant, line.parts[1].group_id)).workOrders;
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.workOrder.update({ where: { id: scrapped.id }, data: { status: 'scrapped', currentStepId: null } });
      await tx.workOrder.create({
        data: { id: newId(), groupId: scrapped.groupId, number: scrapped.number, replacesId: scrapped.id, currentStepId: scrapped.currentStepId },
      });
      await tx.workOrder.updateMany({ where: { groupId: scrapped.groupId, status: 'active', replacesId: null }, data: { status: 'finished', currentStepId: null } });
    });
    await tenant.staff.post('/workflow/moves', { work_order_ids: setPieces, at_step: 'assembly', kind: 'pass' }).expect(409);

    await finish(tenant, line.parts[1].group_id);
    await tenant.staff.post('/workflow/moves', { work_order_ids: setPieces, at_step: 'assembly', kind: 'pass' }).expect(200);
    await tenant.staff.post('/workflow/moves', { work_order_ids: setPieces, at_step: 'packing', kind: 'pass' }).expect(200);
    expect((await staffView(tenant, placed.id)).state).toBe('ready');
  });

  it('prices a lapsed set again whole, and orders it at the price confirmed', async () => {
    const tenant = await freshTenant();
    const quote = await setQuote(tenant);
    await prisma.inTenant(tenant.id, (tx) => tx.quote.update({ where: { id: quote.id }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    await tenant.setChainPrice('5.00');

    const refused = (await order(tenant, [quote.id]).expect(409)).body as { code: string; lines: { position: number; quote: Quote | null }[] };
    expect(refused.code).toBe('price_changed');
    expect(refused.lines).toHaveLength(1);
    const fresh = refused.lines[0].quote!;
    expect(fresh.total).not.toBe(quote.total);

    const placed = (await order(tenant, [fresh.id]).expect(201)).body as Order;
    expect(placed.lines_total).toBe(fresh.total);
    expect(placed.lines[0].parts).toHaveLength(2);
  });
});
