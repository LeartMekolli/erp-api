import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { expectStoredStates } from './stored-states';

interface Order {
  id: string;
  lines: { group_id: string }[];
}

/**
 * Each order's state and payment state are stored, and kept equal to what its facts give, by every
 * change that can move them (Orders list spec, goals 1–7; plan Tasks 1 and 2). What money changes is
 * checked in the payments specs, where the provider is connected.
 */
describe('orders: stored states', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none, so silver is at its fallback.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  /** The priced cast part, published; `courier`; Luna Jewels paying later, Sol Studio paying first (no terms set). */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const sol = ((await staff.post('/customers', { name: 'Sol Studio' }).expect(201)).body as { id: string }).id;
    await staff.put(`/customers/${luna}/payment-terms`, { terms: 'pay_later' }).expect(200);

    /** An order of `lines` lines of 2 pieces each. */
    const place = async (customerId: string, lines = 1) => {
      const quotes = [];
      for (let i = 0; i < lines; i += 1) {
        const quote = (
          (
            await staff
              .post('/pricing/quotes', {
                product_id: cast.productId,
                options: { material: 'silver_925', finish: 'polished' },
                size: { scale: '1.5' },
                quantity: 2,
                file_version_id: cast.versionId,
                customer_id: customerId,
              })
              .expect(201)
          ).body as { quote: { id: string } }
        ).quote.id;
        quotes.push({ quote_id: quote });
      }
      return (await staff.post('/orders', { customer_id: customerId, lines: quotes, address, shipping_method: 'courier' }).expect(201))
        .body as Order;
    };

    return { id: tenant.id, staff, luna, sol, place, defects: cast.workflow.defects };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
  /** What is stored on the order, read straight from the database. */
  const stored = (tenantId: string, id: string) =>
    prisma.inTenant(tenantId, (tx) => tx.order.findUniqueOrThrow({ where: { id }, select: { state: true, paymentState: true } }));
  /** A group's pieces, by number. */
  const pieces = (tenant: Tenant, groupId: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.workOrder.findMany({ where: { groupId }, orderBy: [{ number: 'asc' }, { id: 'asc' }] }));
  /**
   * Puts pieces at a step directly: passing every step before it is Workflow's to test. Nothing about the
   * order changes by this, so its stored state stays right.
   */
  const putAt = (tenant: Tenant, ids: string[], key: string) =>
    prisma.inTenant(tenant.id, async (tx) => {
      const { group } = await tx.workOrder.findFirstOrThrow({ where: { id: ids[0] }, select: { group: { select: { workflowVersionId: true } } } });
      const step = await tx.workflowStep.findFirstOrThrow({ where: { key, versionId: group.workflowVersionId } });
      await tx.workOrder.updateMany({ where: { id: { in: ids } }, data: { status: 'active', currentStepId: step.id } });
    });
  const passPacking = (tenant: Tenant, ids: string[]) => tenant.staff.post('/workflow/moves', { work_order_ids: ids, at_step: 'packing', kind: 'pass' });

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

  it("stores each order's state and payment state as Orders changes it", async () => {
    const tenant = await freshTenant();

    const later = await tenant.place(tenant.luna);
    expect(await stored(tenant.id, later.id)).toEqual({ state: 'in_production', paymentState: 'not_billed' });
    const first = await tenant.place(tenant.sol);
    expect(await stored(tenant.id, first.id)).toEqual({ state: 'awaiting_payment', paymentState: 'awaiting_payment' });
    await expectStoredStates(prisma, app, tenant.id, tenant.staff);

    // Finished directly, as orders-shipping does: shipping decides on the facts, under the order's lock.
    await prisma.inTenant(tenant.id, (tx) =>
      tx.workOrder.updateMany({ where: { groupId: { in: later.lines.map((line) => line.group_id) } }, data: { status: 'finished', currentStepId: null } }),
    );
    await tenant.staff.post(`/orders/${later.id}/ship`, { courier: 'DHL', tracking: 'JD0001' }).expect(200);
    // No payment provider is connected, so no invoice is made: still not billed.
    expect(await stored(tenant.id, later.id)).toEqual({ state: 'shipped', paymentState: 'not_billed' });
    await expectStoredStates(prisma, app, tenant.id, tenant.staff);

    await tenant.staff.post(`/orders/${later.id}/deliver`).expect(200);
    expect(await stored(tenant.id, later.id)).toMatchObject({ state: 'delivered' });
    await expectStoredStates(prisma, app, tenant.id, tenant.staff);

    await tenant.staff.post(`/orders/${first.id}/cancel`, { reason: 'Changed their mind' }).expect(200);
    expect(await stored(tenant.id, first.id)).toEqual({ state: 'cancelled', paymentState: 'none' });
    await expectStoredStates(prisma, app, tenant.id, tenant.staff);
  });

  it('makes the order ready once every piece passes its last step', async () => {
    const tenant = await freshTenant();
    const order = await tenant.place(tenant.luna);
    const ids = (await pieces(tenant, order.lines[0].group_id)).map((piece) => piece.id);
    await putAt(tenant, ids, 'packing');

    await passPacking(tenant, ids).expect(200);
    expect(await stored(tenant.id, order.id)).toMatchObject({ state: 'ready' });
    await expectStoredStates(prisma, app, tenant.id, tenant.staff);
  });

  it("counts a scrapped piece's replacement: the order is ready only once the replacement passes", async () => {
    const tenant = await freshTenant();
    const order = await tenant.place(tenant.luna);
    const [kept, cracked] = await pieces(tenant, order.lines[0].group_id);
    await putAt(tenant, [kept.id], 'packing');
    await putAt(tenant, [cracked.id], 'casting');

    await passPacking(tenant, [kept.id]).expect(200);
    await tenant.staff
      .post('/workflow/moves', { work_order_ids: [cracked.id], at_step: 'casting', kind: 'fail', defect_id: tenant.defects.crack })
      .expect(200);
    expect(await stored(tenant.id, order.id)).toMatchObject({ state: 'in_production' });
    await expectStoredStates(prisma, app, tenant.id, tenant.staff);

    const replacement = (await pieces(tenant, order.lines[0].group_id)).find((piece) => piece.replacesId === cracked.id)!;
    await putAt(tenant, [replacement.id], 'packing');
    await passPacking(tenant, [replacement.id]).expect(200);
    expect(await stored(tenant.id, order.id)).toMatchObject({ state: 'ready' });
    await expectStoredStates(prisma, app, tenant.id, tenant.staff);
  });

  it('puts a ready order back in production when a correction reopens a finished piece', async () => {
    const tenant = await freshTenant();
    const order = await tenant.place(tenant.luna);
    const ids = (await pieces(tenant, order.lines[0].group_id)).map((piece) => piece.id);
    await putAt(tenant, ids, 'packing');
    await passPacking(tenant, ids).expect(200);
    expect(await stored(tenant.id, order.id)).toMatchObject({ state: 'ready' });

    await tenant.staff
      .post('/workflow/moves', { work_order_ids: [ids[0]], kind: 'correction', to_step: 'packing', comment: 'Packed in the wrong box' })
      .expect(200);
    expect(await stored(tenant.id, order.id)).toMatchObject({ state: 'in_production' });
    await expectStoredStates(prisma, app, tenant.id, tenant.staff);
  });

  it('ends ready when the last two pieces finish at once (Review Focus 2)', async () => {
    const tenant = await freshTenant();
    const order = await tenant.place(tenant.luna);
    const [one, two] = await pieces(tenant, order.lines[0].group_id);
    await putAt(tenant, [one.id, two.id], 'packing');

    const [a, b] = await Promise.all([passPacking(tenant, [one.id]), passPacking(tenant, [two.id])]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await stored(tenant.id, order.id)).toMatchObject({ state: 'ready' });
    await expectStoredStates(prisma, app, tenant.id, tenant.staff);
  });

  it('finishes both a move and a line cancel on the same order at once (Review Focus 2)', async () => {
    const tenant = await freshTenant();
    const order = await tenant.place(tenant.luna, 2);
    const ids = (await pieces(tenant, order.lines[0].group_id)).map((piece) => piece.id);
    await putAt(tenant, ids, 'packing');

    const [moved, cancelled] = await Promise.all([
      passPacking(tenant, ids),
      tenant.staff.post(`/orders/${order.id}/cancel`, { reason: 'Only the second', lines: [0] }),
    ]);
    // The cancel always goes through; the move either went first, or finds its pieces cancelled.
    expect(cancelled.status).toBe(200);
    expect([200, 409]).toContain(moved.status);
    expect(await stored(tenant.id, order.id)).toMatchObject({ state: 'in_production' });
    await expectStoredStates(prisma, app, tenant.id, tenant.staff);
  });
});
