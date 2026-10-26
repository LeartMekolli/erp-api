import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { customerOrderResponseSchema, orderResponseSchema } from '../src/modules/orders/order-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Line {
  id: string;
  position: number;
  state: string;
  group_id: string;
  partner: { id: string; name: string } | null;
}
interface Order {
  id: string;
  state: string;
  lines: Line[];
}
interface Quote {
  id: string;
  total: string;
}

/**
 * An order's state, and cancelling it (Orders spec, goals 5 and 12; plan Task 7): states follow the
 * lines' pieces; staff cancel lines or the whole order until it ships; the customer cancels the whole
 * order only while no piece has moved. A cancelled line's open offer is withdrawn, and a partner that
 * had accepted it is owed what staff set, else nothing.
 */
describe('orders: state and cancelling', () => {
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
   * The priced cast part, published; `courier`; MetalWorks able to make the whole cast line, with a
   * member; Luna Jewels with a buyer and a viewer, and Sol Studio with a buyer.
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
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);

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
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
    await staff.put(`/partners/${metalworks}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
    await staff.post(`/partners/${metalworks}/approve`).expect(200);

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const sol = ((await staff.post('/customers', { name: 'Sol Studio' }).expect(201)).body as { id: string }).id;

    /** A quote staff make for Luna. */
    const quote = async (extra: object = {}) =>
      ((
        await staff
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 10,
            file_version_id: cast.versionId,
            customer_id: luna,
            ...extra,
          })
          .expect(201)
      ).body as { quote: Quote }).quote;

    return {
      id: tenant.id,
      staff,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      buyer: await person(tenant.id, 'customer', luna, 'buyer'),
      viewer: await person(tenant.id, 'customer', luna, 'viewer'),
      solBuyer: await person(tenant.id, 'customer', sol, 'buyer'),
      metalworks,
      metalworksPerson: await person(tenant.id, 'partner', metalworks, 'member'),
      luna,
      quote,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
  /** An order of Luna's, one line per quantity, placed by staff. */
  const placeOrder = async (tenant: Tenant, quantities: number[]) => {
    const lines = [];
    for (const quantity of quantities) lines.push({ quote_id: (await tenant.quote({ quantity })).id });
    return (await tenant.staff.post('/orders', { customer_id: tenant.luna, lines, address, shipping_method: 'courier' }).expect(201))
      .body as Order;
  };
  const cancel = (tenant: Tenant, id: string, body: object) => tenant.staff.post(`/orders/${id}/cancel`, body);
  const customerCancel = (tenant: Tenant, id: string, by = tenant.buyer) =>
    by.post(`/portal/customers/${tenant.luna}/orders/${id}/cancel`, { reason: 'Changed my mind' });
  const read = async (tenant: Tenant, id: string) => (await tenant.staff.get(`/orders/${id}`).expect(200)).body as Order;
  const pieces = (tenant: Tenant, groupId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.workOrder.findMany({ where: { groupId }, orderBy: { number: 'asc' } }));
  const passFirstStep = async (tenant: Tenant, groupId: string) => {
    const [first] = await pieces(tenant, groupId);
    await tenant.staff.post('/workflow/moves', { work_order_ids: [first.id], at_step: 'print_pattern', kind: 'pass' }).expect(200);
  };
  const audited = (tenant: Tenant, orderId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.auditEntry.count({ where: { action: 'order.changed', subjectId: orderId } }));

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

  it('lets the customer cancel an order before any piece moved, cancelling every piece', async () => {
    const tenant = await freshTenant();
    const placed = await placeOrder(tenant, [10, 2]);

    const cancelled = await customerCancel(tenant, placed.id).expect(200);
    expectDocumented(customerOrderResponseSchema, cancelled.body);
    expect(cancelled.body).toMatchObject({ state: 'cancelled', lines: [{ state: 'cancelled' }, { state: 'cancelled' }] });

    // Every piece is cancelled, and the log says so: a correction to `cancelled` with the reason.
    for (const line of placed.lines) {
      const rows = await pieces(tenant, line.group_id);
      expect(rows.map((piece) => [piece.status, piece.currentStepId])).toEqual(rows.map(() => ['cancelled', null]));
      const log = await prisma.inTenant(tenant.id, (tx) => tx.transition.findMany({ where: { workOrderId: { in: rows.map((piece) => piece.id) } } }));
      expect(log).toHaveLength(rows.length);
      expect(log.every((row) => row.kind === 'correction' && row.toStatus === 'cancelled' && row.comment === 'Changed my mind')).toBe(true);
    }
    expect((await read(tenant, placed.id)).state).toBe('cancelled');
    expect(await audited(tenant, placed.id)).toBe(2);

    // Nothing left to cancel.
    await customerCancel(tenant, placed.id).expect(409);
    await cancel(tenant, placed.id, { reason: 'Again' }).expect(409);
  });

  it('refuses the customer once a piece has moved, but not staff', async () => {
    const tenant = await freshTenant();
    const placed = await placeOrder(tenant, [10]);
    await passFirstStep(tenant, placed.lines[0].group_id);

    await customerCancel(tenant, placed.id).expect(409);
    // A viewer may not cancel; another customer's buyer doesn't find the order.
    await customerCancel(tenant, placed.id, tenant.viewer).expect(403);
    await tenant.solBuyer.post(`/portal/customers/${tenant.luna}/orders/${placed.id}/cancel`, { reason: 'Mine?' }).expect(404);
    expect((await read(tenant, placed.id)).state).toBe('in_production');

    const cancelled = await cancel(tenant, placed.id, { reason: 'Customer phoned' }).expect(200);
    expectDocumented(orderResponseSchema, cancelled.body);
    expect((cancelled.body as Order).state).toBe('cancelled');
    // The piece that moved is cancelled too: it wasn't finished.
    expect((await pieces(tenant, placed.lines[0].group_id)).every((piece) => piece.status === 'cancelled')).toBe(true);
  });

  it("cancels one line, owing an accepted partner what staff set, and withdraws another line's offer", async () => {
    const tenant = await freshTenant();
    const placed = await placeOrder(tenant, [10, 2]);
    const [first, second] = placed.lines;
    // Line 0 accepted by MetalWorks; line 1 only offered to it.
    await tenant.staff.post(`/partners/jobs/${first.group_id}/offer`, { partner_id: tenant.metalworks }).expect(201);
    await tenant.metalworksPerson.post(`/partner-portal/partners/${tenant.metalworks}/jobs/${first.group_id}/accept`).expect(200);
    await tenant.staff.post(`/partners/jobs/${second.group_id}/offer`, { partner_id: tenant.metalworks }).expect(201);

    // What a partner is owed names a line being cancelled; a line that isn't there is refused.
    await cancel(tenant, placed.id, { reason: 'Nope', lines: [5] }).expect(400);
    await cancel(tenant, placed.id, { reason: 'Nope', lines: [0], partner_owed: [{ position: 1, amount: '5.00', reason: 'x' }] }).expect(400);
    await cancel(tenant, placed.id, { reason: 'Nope', lines: [0], partner_owed: [{ position: 0, amount: '-1', reason: 'x' }] }).expect(400);

    const after = await cancel(tenant, placed.id, {
      reason: 'Customer asked',
      lines: [0],
      partner_owed: [{ position: 0, amount: '25.00', reason: 'Patterns already printed' }],
    }).expect(200);
    expectDocumented(orderResponseSchema, after.body);
    const body = after.body as Order;
    expect(body.lines.map((line) => [line.state, line.partner?.id ?? null])).toEqual([
      ['cancelled', null],
      ['in_production', tenant.metalworks],
    ]);
    expect(body.state).toBe('in_production');

    // MetalWorks is owed 25.00 for the cancelled job, at once.
    const owed = (await tenant.staff.get(`/partners/${tenant.metalworks}/owed`).expect(200)).body as {
      total: string;
      jobs: { group_id: string; state: string; amount: string; override_reason: string | null }[];
    };
    expect(owed.jobs.find((job) => job.group_id === first.group_id)).toMatchObject({
      state: 'owed',
      amount: '25.00',
      override_reason: 'Patterns already printed',
    });
    expect(owed.total).toBe('25.00');
    const firstHistory = (await tenant.staff.get(`/partners/jobs/${first.group_id}`).expect(200)).body as { data: { status: string }[] };
    expect(firstHistory.data.map((row) => row.status)).toEqual(['cancelled']);

    // Cancelling the last line withdraws its open offer, and the order is cancelled.
    await cancel(tenant, placed.id, { reason: 'All of it', lines: [1] }).expect(200);
    const secondHistory = (await tenant.staff.get(`/partners/jobs/${second.group_id}`).expect(200)).body as { data: { status: string }[] };
    expect(secondHistory.data.map((row) => row.status)).toEqual(['withdrawn']);
    expect((await read(tenant, placed.id)).state).toBe('cancelled');

    // A cancelled line can't be cancelled again; each cancelling is audited after the placing.
    await cancel(tenant, placed.id, { reason: 'Again', lines: [0] }).expect(409);
    expect(await audited(tenant, placed.id)).toBe(3);
  });

  it('owes an accepted partner nothing for a cancelled line when staff set no amount', async () => {
    const tenant = await freshTenant();
    const placed = await placeOrder(tenant, [10]);
    const groupId = placed.lines[0].group_id;
    await tenant.staff.post(`/partners/jobs/${groupId}/offer`, { partner_id: tenant.metalworks }).expect(201);
    await tenant.metalworksPerson.post(`/partner-portal/partners/${tenant.metalworks}/jobs/${groupId}/accept`).expect(200);

    await cancel(tenant, placed.id, { reason: 'Customer asked' }).expect(200);
    const owed = (await tenant.staff.get(`/partners/${tenant.metalworks}/owed`).expect(200)).body as {
      jobs: { group_id: string; state: string; amount: string }[];
    };
    expect(owed.jobs.find((job) => job.group_id === groupId)).toMatchObject({ state: 'owed', amount: '0.00' });
  });

  it('makes an order ready once its pieces are finished, and refuses to cancel it once shipped', async () => {
    const tenant = await freshTenant();
    const placed = await placeOrder(tenant, [1, 1]);
    const [first, second] = placed.lines;
    // Finished directly: moving pieces through every step is Workflow's to test.
    const finish = (groupId: string) =>
      prisma.inTenant(tenant.id, (tx) => tx.workOrder.updateMany({ where: { groupId }, data: { status: 'finished', currentStepId: null } }));

    await finish(first.group_id);
    let order = await read(tenant, placed.id);
    expect([order.state, ...order.lines.map((line) => line.state)]).toEqual(['in_production', 'ready', 'in_production']);

    // A ready line and a cancelled one make a ready order.
    await cancel(tenant, placed.id, { reason: 'Only the second', lines: [1] }).expect(200);
    order = await read(tenant, placed.id);
    expect([order.state, ...order.lines.map((line) => line.state)]).toEqual(['ready', 'ready', 'cancelled']);

    await finish(second.group_id);
    // Shipping comes with plan Task 8; until then it is set directly.
    await prisma.inTenant(tenant.id, (tx) => tx.order.update({ where: { id: placed.id }, data: { shippedAt: new Date() } }));
    expect((await read(tenant, placed.id)).state).toBe('shipped');
    await cancel(tenant, placed.id, { reason: 'Too late' }).expect(409);
    await customerCancel(tenant, placed.id).expect(409);
  });

  it('lets members cancel, and keeps cancelling to the workspace', async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const placed = await placeOrder(tenant, [10]);

    await other.staff.post(`/orders/${placed.id}/cancel`, { reason: 'Not mine' }).expect(404);
    await tenant.staff.post(`/orders/${placed.id}/cancel`, {}).expect(400);
    await tenant.member.post(`/orders/${placed.id}/cancel`, { reason: 'Customer phoned' }).expect(200);
  });
});
