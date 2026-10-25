import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { owedJobResponseSchema, partnerOwedResponseSchema, portalOwedResponseSchema } from '../src/modules/partners/partner-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface VersionStep {
  key: string;
  name: string;
  step_type: { id: string };
  checklist: object[];
  defects: { defect_id: string; outcome: string; rework_to: string | null }[];
  rework_targets: string[];
  pass: object;
  fail: object;
  customer: object;
}
interface OwedJob {
  assignment_id: string;
  group_id: string;
  state: 'not_yet' | 'owed';
  amount: string;
  override_reason?: string | null;
}
interface Owed {
  total: string;
  jobs: OwedJob[];
}
interface Piece {
  id: string;
  status: string;
  step_key: string | null;
}

/**
 * What partners are owed (Partners spec, goal 14; P10, P16): a job's frozen cost once every live piece
 * has passed the payout step, or what staff set instead; a correction back before it takes it away until
 * the piece passes again; a remade piece changes nothing; a partner replaced mid-way is owed what staff set.
 */
describe('partners: what they are owed', () => {
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
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  async function partnerPerson(tenantId: string, partnerId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind: 'partner' } });
      await tx.organisationMembership.create({
        data: { userId: user.id, organisationType: 'partner', organisationId: partnerId, role },
      });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /**
   * The priced cast part with packing done in-house, so final QC is the payout step; CastCo and
   * MetalWorks approved for the partner steps; Luna's two jobs of 10 silver polished rings, both
   * accepted by CastCo.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    const { printPattern, castingTree, casting, polishing } = cast.steps;

    const workflowPath = `/workflow/workflows/${cast.workflow.workflowId}`;
    const current = ((await staff.get(workflowPath).expect(200)).body as { current_version: { steps: VersionStep[] } }).current_version;
    await staff
      .put(`${workflowPath}/steps`, {
        steps: current.steps.map((step) => ({
          key: step.key,
          name: step.name,
          step_type_id: step.step_type.id,
          checklist: step.checklist,
          defects: step.defects.map(({ defect_id, outcome, rework_to }) => ({ defect_id, outcome, ...(rework_to ? { rework_to } : {}) })),
          rework_targets: step.rework_targets,
          pass: step.pass,
          fail: step.fail,
          customer: step.customer,
          done_by: step.key === 'packing' ? 'workspace' : 'partner',
        })),
      })
      .expect(200);

    const partner = async (name: string) => {
      const id = ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
      await staff
        .put(`/partners/${id}/capabilities`, {
          capabilities: [printPattern, castingTree, casting, polishing, cast.workflow.notPriced.finalQc].map((step_type_id) => ({
            step_type_id,
            capacity: 200,
            capacity_period: 'week',
          })),
        })
        .expect(200);
      await staff.put(`/partners/${id}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
      await staff.post(`/partners/${id}/prices/copy-from-workspace`).expect(200);
      const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return id;
    };
    const castco = await partner('CastCo');
    const metalworks = await partner('MetalWorks');
    const castcoAdmin = await partnerPerson(tenant.id, castco, 'admin');

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const job = async () => {
      const quoted = await staff
        .post('/pricing/quotes', {
          product_id: cast.productId,
          options: { material: 'silver_925', finish: 'polished' },
          size: { scale: '1.5' },
          file_version_id: cast.versionId,
          quantity: 10,
          customer_id: luna,
        })
        .expect(201);
      const quote = (quoted.body as { quote: { id: string; total: string } }).quote;
      const group = ((await staff.post('/workflow/groups', { quote_id: quote.id }).expect(201)).body as { id: string }).id;
      const offered = await staff.post(`/partners/jobs/${group}/offer`, { partner_id: castco }).expect(201);
      await castcoAdmin.post(`/partner-portal/partners/${castco}/jobs/${group}/accept`).expect(200);
      return { group, quote, cost: (offered.body as { cost: string }).cost };
    };
    const first = await job();
    const second = await job();
    const photo = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;

    return {
      id: tenant.id,
      staff,
      cast,
      castco,
      metalworks,
      first,
      second,
      photo,
      castcoAdmin,
      castcoMember: await partnerPerson(tenant.id, castco, 'member'),
      metalworksAdmin: await partnerPerson(tenant.id, metalworks, 'admin'),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;
  type Person = Tenant['castcoAdmin'];

  const surfaceOk = [{ item: 'surface', value: 'ok' }];

  /** What staff see a partner is owed. */
  const owed = async (tenant: Tenant, partnerId: string) => {
    const response = await tenant.staff.get(`/partners/${partnerId}/owed`).expect(200);
    expectDocumented(partnerOwedResponseSchema, response.body);
    return response.body as Owed;
  };
  const forJob = (all: Owed, group: string) => all.jobs.find((job) => job.group_id === group)!;

  /** The job's pieces still to make or made, as the partner sees them. */
  const live = async (person: Person, partnerId: string, group: string) =>
    ((await person.get(`/partner-portal/partners/${partnerId}/jobs/${group}`).expect(200)).body as { work_orders: Piece[] }).work_orders.filter(
      (piece) => piece.status !== 'scrapped',
    );

  /** The partner passes the pieces at each step, with each step's answers. */
  const pass = async (tenant: Tenant, person: Person, partnerId: string, ids: string[], steps: string[]) => {
    const answers: Record<string, object> = {
      polishing: { answers: surfaceOk },
      final_qc: { answers: [{ item: 'weight', value: '5.0' }], photo_file_version_ids: [tenant.photo] },
    };
    for (const at_step of steps) {
      await person
        .post(`/partner-portal/partners/${partnerId}/moves`, { work_order_ids: ids, kind: 'pass', at_step, ...(answers[at_step] ?? {}) })
        .expect(200);
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

  it('owes CastCo its frozen cost once every live ring passes final QC; a correction takes it back, a remade ring changes nothing', async () => {
    const tenant = await freshTenant();
    const { group, cost } = tenant.first;
    const portal = `/partner-portal/partners/${tenant.castco}`;

    // Nothing passed yet: not owed, but staff see what it will be.
    expect(forJob(await owed(tenant, tenant.castco), group)).toMatchObject({ state: 'not_yet', amount: cost, override_reason: null });
    expect((await owed(tenant, tenant.castco)).total).toBe('0.00');

    let ids = (await live(tenant.castcoAdmin, tenant.castco, group)).map((piece) => piece.id);
    await pass(tenant, tenant.castcoAdmin, tenant.castco, ids, ['print_pattern', 'casting_tree']);

    // Ring 1 cracks at casting: scrapped, and remade from the first step at the partner's own cost.
    await tenant.castcoAdmin
      .post(`${portal}/moves`, { work_order_ids: [ids[0]], kind: 'fail', at_step: 'casting', defect_id: tenant.cast.workflow.defects.crack })
      .expect(200);
    const remade = (await live(tenant.castcoAdmin, tenant.castco, group)).find((piece) => piece.step_key === 'print_pattern')!;
    await pass(tenant, tenant.castcoAdmin, tenant.castco, [remade.id], ['print_pattern', 'casting_tree']);

    ids = (await live(tenant.castcoAdmin, tenant.castco, group)).map((piece) => piece.id);
    expect(ids).toHaveLength(10);
    await pass(tenant, tenant.castcoAdmin, tenant.castco, ids, ['casting', 'polishing']);

    // Nine through final QC: one is still before it, so nothing is owed yet.
    await pass(tenant, tenant.castcoAdmin, tenant.castco, ids.slice(0, 9), ['final_qc']);
    expect(forJob(await owed(tenant, tenant.castco), group)).toMatchObject({ state: 'not_yet', amount: cost });

    // The last one too: owed the cost frozen when the job was offered, remade ring and all.
    await pass(tenant, tenant.castcoAdmin, tenant.castco, ids.slice(9), ['final_qc']);
    let all = await owed(tenant, tenant.castco);
    expect(forJob(all, group)).toMatchObject({ state: 'owed', amount: cost, override_reason: null });
    expect(all.total).toBe(cost);

    // Staff send a ring back to polishing: not owed until it passes final QC again.
    await tenant.staff
      .post('/workflow/moves', { work_order_ids: [ids[3]], kind: 'correction', to_step: 'polishing', comment: 'Back for a polish' })
      .expect(200);
    all = await owed(tenant, tenant.castco);
    expect(forJob(all, group)).toMatchObject({ state: 'not_yet', amount: cost });
    expect(all.total).toBe('0.00');
    await pass(tenant, tenant.castcoAdmin, tenant.castco, [ids[3]], ['polishing', 'final_qc']);
    expect(forJob(await owed(tenant, tenant.castco), group)).toMatchObject({ state: 'owed', amount: cost });

    // Staff pack the rings: finished pieces stay owed.
    await tenant.staff.post('/workflow/moves', { work_order_ids: ids, kind: 'pass', at_step: 'packing' }).expect(200);
    expect(forJob(await owed(tenant, tenant.castco), group)).toMatchObject({ state: 'owed', amount: cost });

    // Staff set a different amount, with a reason.
    const set = await tenant.staff
      .put(`/partners/jobs/${group}/owed`, { partner_id: tenant.castco, amount: '180.00', reason: 'Agreed rush surcharge' })
      .expect(200);
    expectDocumented(owedJobResponseSchema, set.body);
    expect(set.body).toMatchObject({ group_id: group, state: 'owed', amount: '180.00', override_reason: 'Agreed rush surcharge' });
    all = await owed(tenant, tenant.castco);
    expect(forJob(all, group)).toMatchObject({ state: 'owed', amount: '180.00', override_reason: 'Agreed rush surcharge' });
    expect(all.total).toBe('180.00');
    const history = (await tenant.staff.get(`/partners/jobs/${group}`).expect(200)).body as { data: { owed_override: object | null }[] };
    expect(history.data.at(-1)!.owed_override).toEqual({ amount: '180.00', reason: 'Agreed rush surcharge' });

    // Refused: no reason, a malformed amount, a partner the job was never with, and anyone but staff who may assign.
    const path = `/partners/jobs/${group}/owed`;
    await tenant.staff.put(path, { partner_id: tenant.castco, amount: '180.00' }).expect(400);
    await tenant.staff.put(path, { partner_id: tenant.castco, amount: '-5', reason: 'Wrong' }).expect(400);
    await tenant.staff.put(path, { partner_id: tenant.castco, amount: '180.005', reason: 'Wrong' }).expect(400);
    await tenant.staff.put(path, { partner_id: tenant.metalworks, amount: '10.00', reason: 'Never had it' }).expect(404);
    await tenant.staff.put('/partners/jobs/not-an-id/owed', { partner_id: tenant.castco, amount: '10.00', reason: 'Wrong' }).expect(400);
    await tenant.castcoAdmin.put(path, { partner_id: tenant.castco, amount: '999.00', reason: 'Mine' }).expect(403);
    await tenant.castcoAdmin.get(`/partners/${tenant.castco}/owed`).expect(403);
    expect(forJob(await owed(tenant, tenant.castco), group).amount).toBe('180.00');
  });

  it('owes a replaced partner what staff set at once, and the new partner its own cost once done; each partner sees only its own', async () => {
    const tenant = await freshTenant();
    const { group } = tenant.second;

    // CastCo starts the second job, then it moves to MetalWorks, with 40.00 for CastCo's work so far.
    const ids = (await live(tenant.castcoAdmin, tenant.castco, group)).map((piece) => piece.id);
    await pass(tenant, tenant.castcoAdmin, tenant.castco, ids, ['print_pattern']);
    const reason = 'Patterns printed before the breakdown';
    const moved = await tenant.staff
      .post(`/partners/jobs/${group}/reassign`, { partner_id: tenant.metalworks, previous_owed: { amount: '40.00', reason } })
      .expect(201);
    const metalworksCost = (moved.body as { cost: string }).cost;

    // CastCo is owed the 40.00 at once; its first job is still being made.
    const castco = await owed(tenant, tenant.castco);
    expect(castco.jobs.map((job) => [job.group_id, job.state, job.amount, job.override_reason])).toEqual([
      [group, 'owed', '40.00', reason],
      [tenant.first.group, 'not_yet', tenant.first.cost, null],
    ]);
    expect(castco.total).toBe('40.00');

    // MetalWorks is owed its own cost, frozen at the move, once it has passed every ring through final QC.
    expect((await owed(tenant, tenant.metalworks)).jobs).toEqual([
      expect.objectContaining({ group_id: group, state: 'not_yet', amount: metalworksCost }),
    ]);
    await pass(tenant, tenant.metalworksAdmin, tenant.metalworks, ids, ['casting_tree', 'casting', 'polishing', 'final_qc']);
    const metalworks = await owed(tenant, tenant.metalworks);
    expect(metalworks.jobs).toEqual([expect.objectContaining({ group_id: group, state: 'owed', amount: metalworksCost })]);
    expect(metalworks.total).toBe(metalworksCost);

    // CastCo's admin sees its own, without staff's reasons and without the customer.
    const mine = await tenant.castcoAdmin.get(`/partner-portal/partners/${tenant.castco}/owed`).expect(200);
    expectDocumented(portalOwedResponseSchema, mine.body);
    expect((mine.body as Owed).jobs.map((job) => [job.group_id, job.state, job.amount])).toEqual([
      [group, 'owed', '40.00'],
      [tenant.first.group, 'not_yet', tenant.first.cost],
    ]);
    expect((mine.body as Owed).total).toBe('40.00');
    for (const secret of [reason, 'Luna Jewels', 'MetalWorks', tenant.second.quote.id, tenant.second.quote.total]) {
      expect({ secret, found: mine.text.includes(secret) }).toEqual({ secret, found: false });
    }

    // MetalWorks' admin sees only MetalWorks'; a member, or another partner's path, gets nothing.
    const theirs = await tenant.metalworksAdmin.get(`/partner-portal/partners/${tenant.metalworks}/owed`).expect(200);
    expect((theirs.body as Owed).jobs.map((job) => job.group_id)).toEqual([group]);
    await tenant.castcoMember.get(`/partner-portal/partners/${tenant.castco}/owed`).expect(403);
    await tenant.castcoAdmin.get(`/partner-portal/partners/${tenant.metalworks}/owed`).expect(404);
  });
});
