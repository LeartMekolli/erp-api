import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { claimDecisionResponseSchema, customerClaimResponseSchema } from '../src/modules/claims/claim-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Order {
  id: string;
  number: number;
  total: string;
  lines: { id: string; position: number; total: string; group_id: string }[];
}
interface Claim {
  id: string;
  state: string;
  lines: {
    id: string;
    pieces: number;
    decision: { fault?: string; outcome: string; note?: string | null; customer_reason: string | null; refund_amount: string | null } | null;
  }[];
}
interface OwedJob {
  assignment_id: string;
  group_id: string;
  amount: string;
}

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const ADDRESS = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
const d = (value: string) => new Prisma.Decimal(value);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Orders 3a, Task 2: staff decide each claimed line once, refusing with a reason the customer sees or
 * refunding up to the claimed pieces' share; a workshop at fault is owed that share of its cost less while
 * its job is unpaid, and the shortfall is recorded once it was paid.
 */
describe('claims: refusing and refunding claimed lines', () => {
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

  async function person(tenantId: string, kind: 'customer' | 'partner', organisationId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: kind, organisationId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /**
   * The priced cast part; tax at 19 %; the workspace's payment keys; CastCo able to make the whole cast
   * line, with a member; Luna Jewels paying first, with a buyer. A member may change orders but not refund.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '19' }] }).expect(200);
    await staff.put('/payments/account', KEYS).expect(200);

    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;
    const castco = ((await staff.post('/partners', { name: 'CastCo', display_name: 'CastCo' }).expect(201)).body as { id: string }).id;
    await staff
      .put(`/partners/${castco}/capabilities`, {
        capabilities: [printPattern, castingTree, casting, polishing, finalQc, packing].map((step_type_id) => ({
          step_type_id,
          capacity: 200,
          capacity_period: 'week',
        })),
      })
      .expect(200);
    await staff.put(`/partners/${castco}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
    await staff.post(`/partners/${castco}/prices/copy-from-workspace`).expect(200);
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
    await staff.put(`/partners/${castco}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
    await staff.post(`/partners/${castco}/approve`).expect(200);
    const castcoPerson = await person(tenant.id, 'partner', castco, 'member');

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const buyer = await person(tenant.id, 'customer', luna, 'buyer');

    /**
     * Luna's order of 10 pieces, paid by bank transfer, made by CastCo unless `inHouse`, then delivered.
     * Pieces are finished directly: moving them through every step is Workflow's to test.
     */
    const delivered = async (options: { inHouse?: boolean } = {}) => {
      const quote = ((
        await staff
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 10,
            file_version_id: cast.versionId,
            customer_id: luna,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote.id;
      const order = (await staff.post('/orders', { customer_id: luna, lines: [{ quote_id: quote }], address: ADDRESS, shipping_method: 'courier' }).expect(201))
        .body as Order;
      await staff.post(`/orders/${order.id}/paid-by-hand`, { reference: `Transfer ${order.number}`, received_on: today() }).expect(200);
      const group = order.lines[0].group_id;
      if (!options.inHouse) {
        await staff.post(`/partners/jobs/${group}/offer`, { partner_id: castco }).expect(201);
        await castcoPerson.post(`/partner-portal/partners/${castco}/jobs/${group}/accept`).expect(200);
      }
      await prisma.inTenant(tenant.id, (tx) => tx.workOrder.updateMany({ where: { groupId: group }, data: { status: 'finished', currentStepId: null } }));
      await staff.post(`/orders/${order.id}/ship`, { courier: 'DHL', tracking: 'JD0001' }).expect(200);
      await staff.post(`/orders/${order.id}/deliver`).expect(200);
      return order;
    };
    /** Luna's buyer claims 2 of the 10 pieces as faulty. */
    const claim = async (order: Order) =>
      (
        await buyer
          .post(`/portal/customers/${luna}/orders/${order.id}/claims`, { reason: 'defect', description: 'Cracked shanks.', lines: [{ position: 0, pieces: 2 }] })
          .expect(201)
      ).body as Claim;

    return {
      id: tenant.id,
      ownerId: owner.id,
      staff,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      castco,
      luna,
      buyer,
      delivered,
      claim,
    };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const decide = (w: Workspace, claim: Claim, body: object, by = w.staff) => by.post(`/claims/${claim.id}/lines/${claim.lines[0].id}/decision`, body);
  /** What CastCo is owed for the job, as staff see it. */
  const owedFor = async (w: Workspace, group: string) =>
    ((await w.staff.get(`/partners/${w.castco}/owed`).expect(200)).body as { jobs: OwedJob[] }).jobs.find((job) => job.group_id === group)!;
  /** The most the claimed 2 of 10 pieces may be refunded: their share of the line, with tax at 19 %. */
  const shareOf = (order: Order) => d(order.lines[0].total).mul(2).div(10).mul('1.19').toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const raised = (w: Workspace, orderId: string, eventKey: string) =>
    prisma.inTenant(w.id, async (tx) =>
      (await tx.notification.findMany({ where: { eventKey, subjectType: 'order', subjectId: orderId }, orderBy: { id: 'asc' } })).map((row) => row.payload),
    );
  const claimLine = (w: Workspace, claim: Claim) => prisma.inTenant(w.id, (tx) => tx.claimLine.findUniqueOrThrow({ where: { id: claim.lines[0].id } }));

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

  it('refuses a line with a reason the customer sees', async () => {
    const w = await workspace();
    const order = await w.delivered();
    const claim = await w.claim(order);

    // A refusal needs a reason for the customer.
    await decide(w, claim, { fault: 'customer', outcome: 'refuse' }).expect(400);
    // A member changes orders, so may refuse.
    const refused = await decide(w, claim, { fault: 'customer', outcome: 'refuse', note: 'Dropped, by the photos', customer_reason: 'The cracks come from a fall.' }, w.member).expect(200);
    expectDocumented(claimDecisionResponseSchema, refused.body);
    expect(refused.body as Claim).toMatchObject({
      state: 'closed',
      lines: [{ decision: { fault: 'customer', outcome: 'refuse', note: 'Dropped, by the photos', customer_reason: 'The cracks come from a fall.', refund_amount: null } }],
    });

    const seen = await w.buyer.get(`/portal/customers/${w.luna}/claims/${claim.id}`).expect(200);
    expectDocumented(customerClaimResponseSchema, seen.body);
    expect((seen.body as Claim).lines[0].decision).toEqual({
      outcome: 'refuse',
      customer_reason: 'The cracks come from a fall.',
      refund_amount: null,
      remake_group_id: null,
    });
    expect(await raised(w, order.id, 'claim.decided')).toEqual([
      { number: '1', order_number: String(order.number), outcome: 'refused', reason: 'The cracks come from a fall.' },
    ]);
  });

  it('refunds a paid line and lowers what the workshop at fault is owed', async () => {
    const w = await workspace();
    const order = await w.delivered();
    const claim = await w.claim(order);
    const group = order.lines[0].group_id;
    const before = await owedFor(w, group);
    const share = shareOf(order);

    // Never more than the claimed pieces' share; a member may not refund.
    await decide(w, claim, { fault: 'workshop', outcome: 'refund', refund_amount: share.add('0.01').toFixed(2) }).expect(400);
    await decide(w, claim, { fault: 'workshop', outcome: 'refund' }).expect(400);
    await decide(w, claim, { fault: 'workshop', outcome: 'refund', refund_amount: share.toFixed(2) }, w.member).expect(403);

    const refunded = await decide(w, claim, { fault: 'workshop', outcome: 'refund', refund_amount: share.toFixed(2), note: 'Porous casting' }).expect(200);
    expectDocumented(claimDecisionResponseSchema, refunded.body);
    expect((refunded.body as Claim).lines[0].decision).toMatchObject({ fault: 'workshop', outcome: 'refund', refund_amount: share.toFixed(2) });

    // Paid by bank transfer, so given back outside the provider at once, and the customer told.
    const refunds = await prisma.inTenant(w.id, (tx) => tx.refund.findMany({ where: { orderId: order.id } }));
    expect(refunds.map((row) => [row.amount.toFixed(2), row.status])).toEqual([[share.toFixed(2), 'succeeded']]);
    expect(await raised(w, order.id, 'refund.made')).toHaveLength(1);
    expect(await raised(w, order.id, 'claim.decided')).toEqual([{ number: '1', order_number: String(order.number), outcome: 'refunded', reason: '' }]);

    // CastCo is owed its cost for 2 of the 10 pieces less, and the claim line says so.
    const reduction = d(before.amount).mul(2).div(10).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const after = await owedFor(w, group);
    expect(after.amount).toBe(d(before.amount).sub(reduction).toFixed(2));
    expect(after).toMatchObject({ override_reason: expect.stringContaining('Claim 1') });
    const line = await claimLine(w, claim);
    expect([line.partnerId, line.owedReduction?.toFixed(2), line.shortfall]).toEqual([w.castco, reduction.toFixed(2), null]);
  });

  it('records a shortfall when the workshop was already paid', async () => {
    const w = await workspace();
    const order = await w.delivered();
    const claim = await w.claim(order);
    const group = order.lines[0].group_id;
    const before = await owedFor(w, group);

    // CastCo's job is paid out before the claim is decided.
    await prisma.inTenant(w.id, async (tx) => {
      const payout = await tx.payout.create({
        data: { partnerId: w.castco, amount: d(before.amount), currency: 'EUR', status: 'paid', providerTransferId: `tr_${claim.id}`, createdByUserId: w.ownerId },
      });
      await tx.payoutJob.create({ data: { payoutId: payout.id, assignmentId: before.assignment_id, amount: d(before.amount) } });
    });

    await decide(w, claim, { fault: 'workshop', outcome: 'refund', refund_amount: shareOf(order).toFixed(2) }).expect(200);
    const line = await claimLine(w, claim);
    const reduction = d(before.amount).mul(2).div(10).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    expect([line.owedReduction?.toFixed(2), line.shortfall?.toFixed(2)]).toEqual(['0.00', reduction.toFixed(2)]);
    expect((await owedFor(w, group)).amount).toBe(before.amount);
  });

  it('decides a line once (Review Focus 1)', async () => {
    const w = await workspace();
    const order = await w.delivered();
    const claim = await w.claim(order);
    const body = { fault: 'workspace', outcome: 'refund', refund_amount: '1.00' };

    const answers = await Promise.all([decide(w, claim, body), decide(w, claim, body)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(await prisma.inTenant(w.id, (tx) => tx.refund.count({ where: { orderId: order.id } }))).toBe(1);
    // Decided is final.
    await decide(w, claim, { fault: 'customer', outcome: 'refuse', customer_reason: 'No' }).expect(409);
  });

  it('refuses fault on the workshop for a line made in-house, and any decision while the pieces are awaited', async () => {
    const w = await workspace();
    const order = await w.delivered({ inHouse: true });
    const claim = await w.claim(order);

    const refused = await decide(w, claim, { fault: 'workshop', outcome: 'refuse', customer_reason: 'No' }).expect(400);
    expect((refused.body as { errors: { path: string }[] }).errors[0].path).toBe('fault');

    await w.staff.post(`/claims/${claim.id}/return`).expect(200);
    await decide(w, claim, { fault: 'workspace', outcome: 'refuse', customer_reason: 'No' }).expect(409);
    await w.staff.post(`/claims/${claim.id}/returned`).expect(200);
    await decide(w, claim, { fault: 'workspace', outcome: 'refuse', customer_reason: 'No' }).expect(200);

    // Another workspace's staff don't find it.
    const other = await workspace();
    await other.staff.post(`/claims/${claim.id}/lines/${claim.lines[0].id}/decision`, { fault: 'workspace', outcome: 'refuse', customer_reason: 'No' }).expect(404);
  });
});
