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
import { payoutPageResponseSchema } from '../src/modules/payments/payment-response';
import { groupPromise } from '../src/modules/orders/order-lines';
import { workspaceCalendar } from '../src/modules/orders/needs-today';
import { SettingsService } from '../src/modules/settings/settings.service';
import { expectDocumented } from './documented';
import { deleteTestTenants } from './factories';
import { orderWorkspace } from './order-fixtures';
import type { Claim, Order, OrderWorkspace } from './order-fixtures';

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
  order: { id: string; number: number; line_position: number } | null;
}

const d = (value: string) => new Prisma.Decimal(value);

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

  const workspace = () => orderWorkspace(prisma, tokens, as, { runMetal, createdTenants });
  type Workspace = OrderWorkspace;

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
    // Staff see the remake is for the claimed order's line, as the original job is.
    const claimed = { id: order.id, number: order.number, line_position: 0 };
    expect((await owedFor(w, w.castco.id, group)).order).toEqual(claimed);
    expect(original.order).toEqual(claimed);
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
    // Whoever remakes it, the job names the claimed order's line, on what MetalWorks is owed and is paid.
    const claimed = { id: order.id, number: order.number, line_position: 0 };
    const remade = await owedFor(w, w.metalworks.id, group);
    expect(remade.order).toEqual(claimed);
    // A settled payout for it, written straight away: paying is Payments' to test.
    await prisma.inTenant(w.id, (tx) =>
      tx.payout.create({
        data: {
          partnerId: w.metalworks.id,
          amount: offered.cost,
          currency: 'EUR',
          status: 'paid',
          providerTransferId: `tr_${randomBytes(6).toString('hex')}`,
          createdByUserId: w.ownerId,
          settledAt: new Date(),
          jobs: { create: [{ assignmentId: remade.assignment_id, amount: offered.cost }] },
        },
      }),
    );
    const payouts = await w.staff.get(`/partners/${w.metalworks.id}/payouts`).expect(200);
    expectDocumented(payoutPageResponseSchema, payouts.body);
    expect((payouts.body as { data: { jobs: { group_id: string; order: object | null }[] }[] }).data[0].jobs).toEqual([
      expect.objectContaining({ group_id: group, order: claimed }),
    ]);

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

  it("stores the promise on each group: the order's for a line and its parts, the decision's for a remake", async () => {
    const w = await workspace();
    const promiseOf = async (order: Order) =>
      (await prisma.inTenant(w.id, (tx) => tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { promisedOn: true } }))).promisedOn;
    const dueOf = async (group: string) =>
      (await prisma.inTenant(w.id, (tx) => tx.workOrderGroup.findUniqueOrThrow({ where: { id: group }, select: { dueOn: true } }))).dueOn;

    const order = await w.delivered();
    expect(await dueOf(order.lines[0].group_id)).toEqual(await promiseOf(order));

    // The assembly's line and each of its parts: the assembly order's promise.
    const assembly = await w.delivered({ assembly: true });
    const parts = await prisma.inTenant(w.id, (tx) =>
      tx.workOrderGroup.findMany({ where: { orderLinePart: { is: { line: { orderId: assembly.id } } } }, select: { dueOn: true } }),
    );
    expect(parts.length).toBeGreaterThan(0);
    const promised = await promiseOf(assembly);
    expect(await dueOf(assembly.lines[0].group_id)).toEqual(promised);
    for (const part of parts) expect(part.dueOn).toEqual(promised);

    // A remake: its own promise, counted from the decision with the order's speed.
    const group = (await remake(w, await w.claim(order), 'workshop')).remake!.group_id;
    const expected = await prisma.inTenant(w.id, async (tx) => (await groupPromise(tx, group, await workspaceCalendar(tx, new SettingsService()))).promised);
    expect(expected).not.toBeNull();
    expect((await dueOf(group))?.toISOString().slice(0, 10)).toBe(expected);
  });
});
