import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { claimDecisionResponseSchema, claimResponseSchema } from '../src/modules/claims/claim-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { pricedAssembly } from './assembly-fixtures';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Order {
  id: string;
  number: number;
  total: string;
  lines: { id: string; position: number; total: string; group_id: string }[];
}
interface Claim {
  id: string;
  state: string;
  lines: { id: string; pieces: number; decision: { outcome: string; remake_group_id: string | null } | null }[];
  shipment: { courier: string | null; tracking: string | null; delivered_at: string | null } | null;
}
interface Decided extends Claim {
  remake: { group_id: string; unassigned_reasons: string[] } | null;
}
interface Job {
  id: string;
  partner: { id: string };
  kind: string;
  status: string;
  cost: string;
  due_on: string | null;
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
 * Orders 3a, Task 4: a remake goes back to the workshop at fault as an offer at cost 0. Declined, or
 * when it can't take it, staff hand it to another workshop at the normal cost, and the first is owed that
 * much less for the original job; worked in-house, it is owed the claimed pieces' share less. The remake
 * never charges the customer, ships as the claim's own parcel, and an assembly's line is never remade.
 */
describe('claims: remakes', () => {
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
   * The pendant set (`pricedAssembly`, with the cast part under it); CastCo and MetalWorks, each able to
   * make the whole cast line, with a member; Luna Jewels paying by bank transfer, with a buyer.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const set = await pricedAssembly(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    const cast = set.cast;
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/payments/account', KEYS).expect(200);
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;

    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;
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
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return { id, person: await person(tenant.id, 'partner', id, 'member') };
    };
    const castco = await workshop('CastCo');
    const metalworks = await workshop('MetalWorks');

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const buyer = await person(tenant.id, 'customer', luna, 'buyer');

    /**
     * Luna's order, paid by bank transfer, made by CastCo unless `inHouse`, then delivered: 10 cast parts,
     * or 3 pendant sets with `assembly`. Pieces are finished directly: moving them is Workflow's to test.
     */
    const delivered = async (options: { inHouse?: boolean; assembly?: boolean } = {}) => {
      const body = options.assembly
        ? { product_id: set.set, options: { material: 'silver_925', finish: 'polished' }, quantity: 3, customer_id: luna }
        : {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 10,
            file_version_id: cast.versionId,
            customer_id: luna,
          };
      const quote = ((await staff.post('/pricing/quotes', body).expect(201)).body as { quote: { id: string } }).quote.id;
      const order = (await staff.post('/orders', { customer_id: luna, lines: [{ quote_id: quote }], address: ADDRESS, shipping_method: 'courier' }).expect(201))
        .body as Order;
      await staff.post(`/orders/${order.id}/paid-by-hand`, { reference: `Transfer ${order.number}`, received_on: today() }).expect(200);
      const group = order.lines[0].group_id;
      if (!options.inHouse && !options.assembly) {
        await staff.post(`/partners/jobs/${group}/offer`, { partner_id: castco.id }).expect(201);
        await castco.person.post(`/partner-portal/partners/${castco.id}/jobs/${group}/accept`).expect(200);
      }
      // Every group of the order: the line's, and an assembly's parts'.
      await prisma.inTenant(tenant.id, (tx) =>
        tx.workOrder.updateMany({
          where: { group: { OR: [{ orderLine: { is: { orderId: order.id } } }, { orderLinePart: { is: { line: { orderId: order.id } } } }] } },
          data: { status: 'finished', currentStepId: null },
        }),
      );
      await staff.post(`/orders/${order.id}/ship`, { courier: 'DHL', tracking: 'JD0001' }).expect(200);
      await staff.post(`/orders/${order.id}/deliver`).expect(200);
      return order;
    };
    /** Luna's buyer claims 2 pieces of the first line as faulty, or `pieces`. */
    const claim = async (order: Order, pieces = 2) =>
      (
        await buyer
          .post(`/portal/customers/${luna}/orders/${order.id}/claims`, { reason: 'defect', description: 'Cracked shanks.', lines: [{ position: 0, pieces }] })
          .expect(201)
      ).body as Claim;

    return { id: tenant.id, staff, castco, metalworks, workshop, luna, buyer, delivered, claim };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const decide = (w: Workspace, claim: Claim, body: object) => w.staff.post(`/claims/${claim.id}/lines/${claim.lines[0].id}/decision`, body);
  /** Decides the claim's line a remake at `fault`, and answers the decision. */
  const remake = async (w: Workspace, claim: Claim, fault: string) =>
    (await decide(w, claim, { fault, outcome: 'remake', note: 'Porous casting' }).expect(200)).body as Decided;
  const history = async (w: Workspace, group: string) => ((await w.staff.get(`/partners/jobs/${group}`).expect(200)).body as { data: Job[] }).data;
  /** What `partner` is owed for the job of `group`, as staff see it. */
  const owedFor = async (w: Workspace, partner: string, group: string) =>
    ((await w.staff.get(`/partners/${partner}/owed`).expect(200)).body as { jobs: OwedJob[] }).jobs.find((job) => job.group_id === group)!;
  const raised = (w: Workspace, eventKey: string, subjectType = 'order') =>
    prisma.inTenant(w.id, async (tx) =>
      (await tx.notification.findMany({ where: { eventKey, subjectType }, orderBy: { id: 'asc' } })).map((row) => ({ subjectId: row.subjectId, payload: row.payload })),
    );
  const claimLine = (w: Workspace, claim: Claim) => prisma.inTenant(w.id, (tx) => tx.claimLine.findUniqueOrThrow({ where: { id: claim.lines[0].id } }));
  const pieces = (w: Workspace, group: string) =>
    prisma.inTenant(w.id, (tx) => tx.workOrder.findMany({ where: { groupId: group }, orderBy: { number: 'asc' } }));
  const passFirstStep = async (w: Workspace, group: string, piece = 0) => {
    const all = await pieces(w, group);
    await w.staff.post('/workflow/moves', { work_order_ids: [all[piece].id], at_step: 'print_pattern', kind: 'pass' }).expect(200);
  };
  /** The share of CastCo's cost for 2 of the 10 pieces it made, as a refund would take it off. */
  const shareOf = (owed: OwedJob) => d(owed.amount).mul(2).div(10).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

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

  it('remakes a line at the workshop at fault, at no cost to anyone else', async () => {
    const w = await workspace();
    const order = await w.delivered();
    const claim = await w.claim(order);
    const original = await owedFor(w, w.castco.id, order.lines[0].group_id);
    const journals = () => prisma.inTenant(w.id, (tx) => tx.ledgerJournal.count({ where: { orderId: order.id } }));
    const journalsBefore = await journals();

    const decided = await decide(w, claim, { fault: 'workshop', outcome: 'remake', note: 'Porous casting' }).expect(200);
    expectDocumented(claimDecisionResponseSchema, decided.body);
    const body = decided.body as Decided;
    expect(body.remake).toEqual({ group_id: expect.any(String), unassigned_reasons: [] });
    const group = body.remake!.group_id;
    expect(body).toMatchObject({ state: 'decided', lines: [{ decision: { outcome: 'remake', remake_group_id: group } }] });

    // A new group of the 2 claimed pieces, started from the line's quote for the claim line.
    const started = await prisma.inTenant(w.id, (tx) => tx.workOrderGroup.findUniqueOrThrow({ where: { id: group } }));
    expect([started.sourceType, started.sourceId, started.quantity]).toEqual(['claim_line', claim.lines[0].id, 2]);
    expect(await pieces(w, group)).toHaveLength(2);

    // Offered back to CastCo at cost 0, by the remake's own date, and CastCo is told as of any offer.
    const jobs = await history(w, group);
    expect(jobs).toEqual([expect.objectContaining({ partner: expect.objectContaining({ id: w.castco.id }), kind: 'offer', status: 'offered', cost: '0.00' })]);
    expect(jobs[0].due_on).not.toBeNull();
    expect((await raised(w, 'partner.job.offered', 'job_assignment')).map((row) => row.subjectId)).toContain(jobs[0].id);

    // The customer pays nothing more, CastCo's original job is owed as before, and the customer is told.
    const read = (await w.staff.get(`/orders/${order.id}`).expect(200)).body as Order;
    expect(read.total).toBe(order.total);
    expect(await journals()).toBe(journalsBefore);
    expect(await prisma.inTenant(w.id, (tx) => tx.refund.count({ where: { orderId: order.id } }))).toBe(0);
    expect((await owedFor(w, w.castco.id, order.lines[0].group_id)).amount).toBe(original.amount);
    expect((await raised(w, 'claim.decided')).map((row) => row.payload)).toEqual([
      { number: '1', order_number: String(order.number), outcome: 'made again', reason: '' },
    ]);
    const line = await claimLine(w, claim);
    expect([line.partnerId, line.remakeGroupId, line.owedReduction]).toEqual([w.castco.id, group, null]);

    // CastCo accepts: its own remake costs nobody anything, and is never paid for.
    await w.castco.person.post(`/partner-portal/partners/${w.castco.id}/jobs/${group}/accept`).expect(200);
    expect((await claimLine(w, claim)).owedReduction).toBeNull();
    expect((await owedFor(w, w.castco.id, order.lines[0].group_id)).amount).toBe(original.amount);
  });

  it("hands a declined remake to another workshop and lowers the first one's owed (Review Focus 4)", async () => {
    const w = await workspace();
    const order = await w.delivered();
    const claim = await w.claim(order);
    const originalGroup = order.lines[0].group_id;
    const before = await owedFor(w, w.castco.id, originalGroup);
    const group = (await remake(w, claim, 'workshop')).remake!.group_id;

    await w.castco.person.post(`/partner-portal/partners/${w.castco.id}/jobs/${group}/decline`).expect(200);
    // The workshop at fault is never paid for its own remake.
    const refused = await w.staff.post(`/partners/jobs/${group}/offer`, { partner_id: w.castco.id }).expect(409);
    expect((refused.body as { errors: { path: string }[] }).errors[0].path).toBe('partner_id');

    // MetalWorks takes it at its normal cost for the 2 pieces.
    const offered = (await w.staff.post(`/partners/jobs/${group}/offer`, { partner_id: w.metalworks.id }).expect(201)).body as Job;
    const cost = d(offered.cost);
    expect(cost.gt(0)).toBe(true);
    await w.metalworks.person.post(`/partner-portal/partners/${w.metalworks.id}/jobs/${group}/accept`).expect(200);

    // CastCo is owed that much less for the original job, never below 0, and the line says so.
    const reduced = Prisma.Decimal.min(cost, d(before.amount));
    const after = await owedFor(w, w.castco.id, originalGroup);
    expect(after.amount).toBe(d(before.amount).sub(reduced).toFixed(2));
    expect(after).toMatchObject({ override_reason: expect.stringContaining('Claim 1') });
    const line = await claimLine(w, claim);
    expect([line.owedReduction?.toFixed(2), line.shortfall?.toFixed(2) ?? null]).toEqual([
      reduced.toFixed(2),
      cost.gt(reduced) ? cost.sub(reduced).toFixed(2) : null,
    ]);

    // Moved on to a third workshop, the remake never lowers CastCo's owed a second time.
    const foundry = await w.workshop('FoundryOne');
    await w.staff.post(`/partners/jobs/${group}/reassign`, { partner_id: foundry.id }).expect(201);
    expect((await owedFor(w, w.castco.id, originalGroup)).amount).toBe(after.amount);
    expect((await claimLine(w, claim)).owedReduction?.toFixed(2)).toBe(reduced.toFixed(2));
  });

  it("works a declined remake in-house and lowers the first one's owed by the pieces' share once", async () => {
    const w = await workspace();
    const order = await w.delivered();
    const claim = await w.claim(order);
    const originalGroup = order.lines[0].group_id;
    const before = await owedFor(w, w.castco.id, originalGroup);
    const group = (await remake(w, claim, 'workshop')).remake!.group_id;
    await w.castco.person.post(`/partner-portal/partners/${w.castco.id}/jobs/${group}/decline`).expect(200);

    // Nothing is taken off until the workspace starts making it.
    expect((await owedFor(w, w.castco.id, originalGroup)).amount).toBe(before.amount);
    await passFirstStep(w, group, 0);
    const share = shareOf(before);
    expect((await owedFor(w, w.castco.id, originalGroup)).amount).toBe(d(before.amount).sub(share).toFixed(2));
    expect((await claimLine(w, claim)).owedReduction?.toFixed(2)).toBe(share.toFixed(2));

    // The second piece passing takes nothing more off.
    await passFirstStep(w, group, 1);
    expect((await owedFor(w, w.castco.id, originalGroup)).amount).toBe(d(before.amount).sub(share).toFixed(2));
  });

  it('leaves a remake unassigned when the workshop at fault is suspended (Review Focus 3)', async () => {
    const w = await workspace();
    const order = await w.delivered();
    const claim = await w.claim(order);
    await w.staff.post(`/partners/${w.castco.id}/suspend`).expect(200);

    const decided = await remake(w, claim, 'workshop');
    expect(decided.remake!.unassigned_reasons).toEqual(expect.arrayContaining([expect.stringContaining('suspended')]));
    const group = decided.remake!.group_id;
    expect(await prisma.inTenant(w.id, (tx) => tx.workOrderGroup.count({ where: { id: group } }))).toBe(1);
    expect(await history(w, group)).toEqual([]);
    expect([(await claimLine(w, claim)).partnerId]).toEqual([w.castco.id]);

    // Staff hand it to another workshop.
    await w.staff.post(`/partners/jobs/${group}/offer`, { partner_id: w.metalworks.id }).expect(201);
  });

  it('remakes in-house when the workspace is at fault: no offer, no reduction', async () => {
    const w = await workspace();
    const order = await w.delivered();
    const claim = await w.claim(order);
    const originalGroup = order.lines[0].group_id;
    const before = await owedFor(w, w.castco.id, originalGroup);

    const decided = await remake(w, claim, 'workspace');
    expect(decided.remake!.unassigned_reasons).toEqual([]);
    const group = decided.remake!.group_id;
    expect(await history(w, group)).toEqual([]);

    await passFirstStep(w, group);
    expect((await owedFor(w, w.castco.id, originalGroup)).amount).toBe(before.amount);
    const line = await claimLine(w, claim);
    expect([line.partnerId, line.owedReduction, line.shortfall]).toEqual([null, null, null]);
  });

  it('ships the remake once finished, and tells the customer', async () => {
    const w = await workspace();
    const order = await w.delivered({ inHouse: true });
    const claim = await w.claim(order);

    // Nothing to ship before a remake is decided.
    await w.staff.post(`/claims/${claim.id}/ship`, {}).expect(409);
    const group = (await remake(w, claim, 'workspace')).remake!.group_id;
    await w.staff.post(`/claims/${claim.id}/ship`, { courier: 'DHL', tracking: 'JD0002' }).expect(409);
    await w.staff.post(`/claims/${claim.id}/delivered`).expect(409);

    await prisma.inTenant(w.id, (tx) => tx.workOrder.updateMany({ where: { groupId: group }, data: { status: 'finished', currentStepId: null } }));
    const shipped = await w.staff.post(`/claims/${claim.id}/ship`, { courier: 'DHL', tracking: 'JD0002' }).expect(200);
    expectDocumented(claimResponseSchema, shipped.body);
    expect(shipped.body as Claim).toMatchObject({ state: 'decided', shipment: { courier: 'DHL', tracking: 'JD0002', delivered_at: null } });
    await w.staff.post(`/claims/${claim.id}/ship`, {}).expect(409);
    expect((await raised(w, 'claim.remake_shipped')).map((row) => row.payload)).toEqual([
      { number: '1', order_number: String(order.number), courier: 'DHL', tracking: 'JD0002' },
    ]);

    const delivered = await w.staff.post(`/claims/${claim.id}/delivered`).expect(200);
    expectDocumented(claimResponseSchema, delivered.body);
    expect(delivered.body as Claim).toMatchObject({ state: 'closed', shipment: { delivered_at: expect.any(String) } });
    await w.staff.post(`/claims/${claim.id}/delivered`).expect(409);
    // The original order stays delivered.
    expect(((await w.staff.get(`/orders/${order.id}`).expect(200)).body as { state: string }).state).toBe('delivered');
  });

  it('refuses to remake an assembly line', async () => {
    const w = await workspace();
    const order = await w.delivered({ assembly: true });
    const claim = await w.claim(order, 1);

    const refused = await decide(w, claim, { fault: 'workspace', outcome: 'remake' }).expect(400);
    expect((refused.body as { errors: { path: string }[] }).errors[0].path).toBe('outcome');
    expect((await claimLine(w, claim)).outcome).toBeNull();
  });
});
