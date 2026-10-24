import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { moveResponseSchema, workOrderDetailResponseSchema } from '../src/modules/workflow/work-order-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Piece {
  id: string;
  label: string;
  status: string;
  step: { key: string } | null;
}
interface Transition {
  kind: string;
  outcome: string | null;
  from_step: { key: string } | null;
  to_step: { key: string } | null;
  defect: { key: string; name: string } | null;
  override_reason: string | null;
  comment: string | null;
  answers: { item: string; value: string | boolean; note: string | null; passing: boolean }[];
  photo_file_version_ids: string[];
  actor: { id: string; name: string };
}
interface Detail extends Piece {
  history: Transition[];
}
interface Problem {
  errors?: { path: string; message: string }[];
}

describe('workflow: moving pieces through their steps', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const customer = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, (tx) => tx.user.update({ where: { id: customer.id }, data: { kind: 'customer' } }));
    const as = (token: string) => ({
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    });
    const ownerClient = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const setup = await pricedCastPart(ownerClient, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    return {
      id: tenant.id,
      ownerId: owner.id,
      setup,
      owner: ownerClient,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      customer: as((await tokens.issueForUser(tenant.id, customer.id)).accessToken),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** Starts a polished silver quote of `quantity` pieces; returns them in number order. */
  async function started(tenant: Tenant, quantity = 10): Promise<Piece[]> {
    const quoted = await tenant.owner
      .post('/pricing/quotes', {
        product_id: tenant.setup.productId,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        file_version_id: tenant.setup.versionId,
        quantity,
      })
      .expect(201);
    const quoteId = (quoted.body as { quote: { id: string } }).quote.id;
    const group = (await tenant.owner.post('/workflow/groups', { quote_id: quoteId }).expect(201)).body as { id: string };
    const listed = await tenant.owner.get(`/workflow/work-orders?group_id=${group.id}&limit=100`).expect(200);
    return (listed.body as { data: Piece[] }).data;
  }

  const ids = (pieces: Piece[]) => pieces.map((piece) => piece.id);
  const move = (tenant: Tenant, body: object) => tenant.owner.post('/workflow/moves', body);
  const pass = (tenant: Tenant, pieces: Piece[], atStep: string, extra: object = {}) =>
    move(tenant, { work_order_ids: ids(pieces), at_step: atStep, kind: 'pass', ...extra });

  /** Passes the pieces from print pattern through casting, so they wait at polishing. */
  async function toPolishing(tenant: Tenant, pieces: Piece[]) {
    for (const step of ['print_pattern', 'casting_tree', 'casting']) {
      await pass(tenant, pieces, step).expect(200);
    }
  }

  const detail = async (tenant: Tenant, piece: Piece) =>
    (await tenant.owner.get(`/workflow/work-orders/${piece.id}`).expect(200)).body as Detail;
  const stepOf = async (tenant: Tenant, piece: Piece) => (await detail(tenant, piece)).step?.key ?? null;
  const lastMove = async (tenant: Tenant, piece: Piece) => (await detail(tenant, piece)).history.at(-1);
  const transitions = async (tenant: Tenant) =>
    (await prisma.inTenant(tenant.id, (tx) => tx.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM transition`))[0]
      .count;
  const photo = async (tenant: Tenant, status = 'uploaded') =>
    (await measuredDesign(prisma, tenant.id, tenant.ownerId, { status, measures: [] })).versionId;
  const errorPaths = (response: request.Response) => ((response.body as Problem).errors ?? []).map((error) => error.path);

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

  it('passes many pieces in one move, writing one transition per piece with the answers', async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    await toPolishing(tenant, pieces);

    const moved = await pass(tenant, pieces, 'polishing', { answers: [{ item: 'surface', value: 'ok', note: 'Even shine' }] }).expect(200);
    expectDocumented(moveResponseSchema, moved.body);
    const data = (moved.body as { data: Piece[] }).data;
    expect(data.map((piece) => piece.label)).toEqual(pieces.map((piece) => piece.label));
    // Polished silver isn't plated, so the next step on its path is final QC.
    expect(data.every((piece) => piece.status === 'active' && piece.step?.key === 'final_qc')).toBe(true);
    expect(await transitions(tenant)).toBe(40);

    const one = await tenant.owner.get(`/workflow/work-orders/${pieces[6].id}`).expect(200);
    expectDocumented(workOrderDetailResponseSchema, one.body);
    const { history } = one.body as Detail;
    expect(history.map((row) => `${row.from_step?.key}>${row.to_step?.key}`)).toEqual([
      'print_pattern>casting_tree',
      'casting_tree>casting',
      'casting>polishing',
      'polishing>final_qc',
    ]);
    expect(history[3]).toMatchObject({
      kind: 'pass',
      outcome: null,
      defect: null,
      override_reason: null,
      comment: null,
      answers: [{ item: 'surface', value: 'ok', note: 'Even shine', passing: true }],
      photo_file_version_ids: [],
      actor: { id: tenant.ownerId },
    });
  });

  it('refuses a pass the QC gate does not allow, and moves nothing', async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant, 2);
    await toPolishing(tenant, pieces);
    const before = await transitions(tenant);

    expect(errorPaths(await pass(tenant, pieces, 'polishing').expect(400))).toEqual(['surface']);
    expect(errorPaths(await pass(tenant, pieces, 'polishing', { answers: [{ item: 'surface', value: 'pitted' }] }).expect(400))).toEqual([
      'surface',
    ]);
    expect(await stepOf(tenant, pieces[0])).toBe('polishing');
    expect(await transitions(tenant)).toBe(before);

    await pass(tenant, pieces, 'polishing', { answers: [{ item: 'surface', value: 'ok' }] }).expect(200);
    const weighed = { answers: [{ item: 'weight', value: '5.0' }] };
    expect(errorPaths(await pass(tenant, pieces, 'final_qc', weighed).expect(400))).toEqual(['photos']);
    expect(
      errorPaths(
        await pass(tenant, pieces, 'final_qc', { answers: [{ item: 'weight', value: '5.3' }], photo_file_version_ids: [await photo(tenant)] }).expect(
          400,
        ),
      ),
    ).toEqual(['weight']);

    // A photo still being uploaded, or another workspace's, isn't there to attach.
    await pass(tenant, pieces, 'final_qc', { ...weighed, photo_file_version_ids: [await photo(tenant, 'pending')] }).expect(404);
    const other = await freshTenant();
    await pass(tenant, pieces, 'final_qc', { ...weighed, photo_file_version_ids: [await photo(other)] }).expect(404);
    await pass(tenant, pieces, 'final_qc', { ...weighed, photo_file_version_ids: [newId()] }).expect(404);
    expect(await stepOf(tenant, pieces[1])).toBe('final_qc');

    const shot = await photo(tenant);
    await pass(tenant, pieces, 'final_qc', { ...weighed, photo_file_version_ids: [shot] }).expect(200);
    expect(await lastMove(tenant, pieces[1])).toMatchObject({
      from_step: { key: 'final_qc' },
      to_step: { key: 'packing' },
      answers: [{ item: 'weight', value: '5.0', note: null, passing: true }],
      photo_file_version_ids: [shot],
    });
  });

  it("fails pieces back to the defect's rework target, or elsewhere with a reason", async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    await toPolishing(tenant, pieces);
    const { scratch, porosity } = tenant.setup.workflow.defects;
    const fail = (some: Piece[], extra: object) =>
      move(tenant, { work_order_ids: ids(some), at_step: 'polishing', kind: 'fail', comment: 'Seen under the lamp', ...extra });

    // Polishing asks for a comment on every fail.
    expect(
      errorPaths(await move(tenant, { work_order_ids: ids(pieces.slice(0, 3)), at_step: 'polishing', kind: 'fail', defect_id: scratch }).expect(400)),
    ).toEqual(['comment']);

    await fail(pieces.slice(0, 3), { defect_id: scratch, answers: [{ item: 'surface', value: 'pitted' }] }).expect(200);
    expect(await lastMove(tenant, pieces[0])).toMatchObject({
      kind: 'fail',
      outcome: 'rework',
      from_step: { key: 'polishing' },
      to_step: { key: 'polishing' },
      defect: { key: 'scratch', name: 'Scratch' },
      override_reason: null,
      comment: 'Seen under the lamp',
      answers: [{ item: 'surface', value: 'pitted', note: null, passing: false }],
    });
    expect((await lastMove(tenant, pieces[3]))?.to_step?.key).toBe('polishing');
    expect((await lastMove(tenant, pieces[3]))?.kind).toBe('pass');

    // Porosity goes back to casting by default.
    await fail([pieces[3]], { defect_id: porosity }).expect(200);
    expect(await stepOf(tenant, pieces[3])).toBe('casting');

    // Anything but the defect's default needs a reason.
    await fail([pieces[4]], { defect_id: scratch, outcome: 'continue' }).expect(400);
    await fail([pieces[4]], { defect_id: scratch, rework_to: 'casting' }).expect(400);
    expect(await stepOf(tenant, pieces[4])).toBe('polishing');

    await fail([pieces[4]], { defect_id: scratch, outcome: 'continue', override_reason: 'Customer accepts light marks' }).expect(200);
    expect(await lastMove(tenant, pieces[4])).toMatchObject({
      outcome: 'continue',
      to_step: { key: 'final_qc' },
      defect: { key: 'scratch' },
      override_reason: 'Customer accepts light marks',
    });
    await fail([pieces[5]], { defect_id: scratch, rework_to: 'casting', override_reason: 'Too deep to polish out' }).expect(200);
    expect(await stepOf(tenant, pieces[5])).toBe('casting');

    // Only the step's rework targets, and only a defect the step allows.
    await fail([pieces[6]], { defect_id: scratch, rework_to: 'print_pattern', override_reason: 'Start over' }).expect(400);
    const other = await freshTenant();
    await fail([pieces[6]], { defect_id: other.setup.workflow.defects.scratch }).expect(400);
    expect(await stepOf(tenant, pieces[6])).toBe('polishing');
  });

  it('moves nothing when a piece is elsewhere, on another version, unknown or not of this workspace', async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant, 3);
    await pass(tenant, [pieces[0]], 'print_pattern').expect(200);

    const elsewhere = await pass(tenant, pieces, 'print_pattern').expect(409);
    expect(errorPaths(elsewhere)).toEqual(['work_order_ids.0']);
    expect(JSON.stringify(elsewhere.body)).toContain('1/3');
    expect(await stepOf(tenant, pieces[1])).toBe('print_pattern');

    await move(tenant, { work_order_ids: [pieces[1].id, newId()], at_step: 'print_pattern', kind: 'pass' }).expect(404);
    expect(await stepOf(tenant, pieces[1])).toBe('print_pattern');

    const other = await freshTenant();
    await move(other, { work_order_ids: [pieces[1].id], at_step: 'print_pattern', kind: 'pass' }).expect(404);
    expect(await stepOf(tenant, pieces[1])).toBe('print_pattern');

    // The same step key, but the newer group runs on version 2.
    await tenant.setup.workflow.setSteps();
    const [newer] = await started(tenant, 1);
    const mixed = await move(tenant, { work_order_ids: [pieces[1].id, newer.id], at_step: 'print_pattern', kind: 'pass' }).expect(409);
    expect(errorPaths(mixed)).toEqual(['work_order_ids.1']);
    expect(await stepOf(tenant, newer)).toBe('print_pattern');
  });

  it('lets only one of two simultaneous passes of a piece through', async () => {
    const tenant = await freshTenant();
    const [piece] = await started(tenant, 1);

    const results = await Promise.all([pass(tenant, [piece], 'print_pattern'), pass(tenant, [piece], 'print_pattern')]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await stepOf(tenant, piece)).toBe('casting_tree');
    expect((await detail(tenant, piece)).history).toHaveLength(1);
  });

  it('corrects a mistaken move to any step on the path, and reopens a finished piece', async () => {
    const tenant = await freshTenant();
    const [piece] = await started(tenant, 1);
    await toPolishing(tenant, [piece]);
    const correct = (body: object) => move(tenant, { work_order_ids: [piece.id], kind: 'correction', ...body });

    expect(errorPaths(await correct({ to_step: 'casting_tree' }).expect(400))).toEqual(['comment']);
    // Plating isn't on a polished piece's path.
    await correct({ to_step: 'plating', comment: 'Wrong tray' }).expect(400);
    await correct({ to_step: 'nowhere', comment: 'Wrong tray' }).expect(400);
    // Where it already is: nothing to correct.
    expect(errorPaths(await correct({ to_step: 'polishing', comment: 'Wrong tray' }).expect(400))).toEqual(['work_order_ids.0']);
    expect(await stepOf(tenant, piece)).toBe('polishing');

    await correct({ to_step: 'casting_tree', comment: 'Passed the wrong tray' }).expect(200);
    expect(await lastMove(tenant, piece)).toMatchObject({
      kind: 'correction',
      outcome: null,
      from_step: { key: 'polishing' },
      to_step: { key: 'casting_tree' },
      comment: 'Passed the wrong tray',
      answers: [],
    });

    await pass(tenant, [piece], 'casting_tree').expect(200);
    await pass(tenant, [piece], 'casting').expect(200);
    await pass(tenant, [piece], 'polishing', { answers: [{ item: 'surface', value: 'ok' }] }).expect(200);
    await pass(tenant, [piece], 'final_qc', { answers: [{ item: 'weight', value: '4.9' }], photo_file_version_ids: [await photo(tenant)] }).expect(
      200,
    );
    await pass(tenant, [piece], 'packing').expect(200);
    expect(await detail(tenant, piece)).toMatchObject({ status: 'finished', step: null });
    expect(await lastMove(tenant, piece)).toMatchObject({ from_step: { key: 'packing' }, to_step: null });
    await pass(tenant, [piece], 'packing').expect(409);

    await correct({ to_step: 'packing', comment: 'Box was damaged' }).expect(200);
    expect(await detail(tenant, piece)).toMatchObject({ status: 'active', step: { key: 'packing' } });
    expect(await lastMove(tenant, piece)).toMatchObject({ kind: 'correction', from_step: null, to_step: { key: 'packing' } });
  });

  it('keeps running pieces on the workflow version they started on', async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant, 2);
    const inspection = (
      (await tenant.owner.post('/pricing/step-types', { key: 'inspection', name: 'Inspection', position: 85, summary_group: null }).expect(201))
        .body as { id: string }
    ).id;
    await tenant.setup.workflow.setSteps([
      {
        key: 'inspection',
        name: 'Inspection',
        step_type_id: inspection,
        checklist: [{ key: 'gauge', label: 'Gauge', required: true, kind: 'yes_no', passing_answer: true }],
      },
    ]);

    await toPolishing(tenant, pieces);
    await pass(tenant, pieces, 'polishing', { answers: [{ item: 'surface', value: 'ok' }] }).expect(200);
    expect(await stepOf(tenant, pieces[0])).toBe('final_qc');
    await pass(tenant, pieces, 'final_qc', { answers: [{ item: 'weight', value: '5.2' }], photo_file_version_ids: [await photo(tenant)] }).expect(
      200,
    );
    expect(await stepOf(tenant, pieces[1])).toBe('packing');

    const [newer] = await started(tenant, 1);
    expect((await tenant.owner.get(`/workflow/work-orders/${newer.id}`).expect(200)).body).toMatchObject({
      path: ['print_pattern', 'casting_tree', 'casting', 'polishing', 'inspection', 'final_qc', 'packing'].map((key) => ({ key })),
    });
  });

  it("keeps running pieces on their version's path when a step type starts or stops being priced", async () => {
    const tenant = await freshTenant();
    const [piece] = await started(tenant, 1);
    const { workflowId, notPriced } = tenant.setup.workflow;

    // Final QC becomes priced; nothing prices it for this piece, yet its version still runs it.
    await tenant.owner.patch(`/pricing/step-types/${notPriced.finalQc}`, { summary_group: 'finishing' }).expect(200);
    expect((await tenant.owner.get(`/workflow/work-orders/${piece.id}`).expect(200)).body).toMatchObject({
      path: ['print_pattern', 'casting_tree', 'casting', 'polishing', 'final_qc', 'packing'].map((key) => ({ key })),
    });
    const version = (await tenant.owner.get(`/workflow/workflows/${workflowId}/versions/1`).expect(200)).body as {
      steps: { key: string; step_type: { priced: boolean } }[];
    };
    expect(version.steps.find((step) => step.key === 'final_qc')?.step_type.priced).toBe(false);

    await toPolishing(tenant, [piece]);
    await pass(tenant, [piece], 'polishing', { answers: [{ item: 'surface', value: 'ok' }] }).expect(200);
    expect(await stepOf(tenant, piece)).toBe('final_qc');
    await pass(tenant, [piece], 'final_qc', { answers: [{ item: 'weight', value: '5.0' }], photo_file_version_ids: [await photo(tenant)] }).expect(
      200,
    );
    expect(await stepOf(tenant, piece)).toBe('packing');
  });

  it("orders a piece's history by move, not by when its transaction began", async () => {
    const tenant = await freshTenant();
    const [piece] = await started(tenant, 1);
    await pass(tenant, [piece], 'print_pattern').expect(200);
    const steps = await prisma.inTenant(tenant.id, (tx) =>
      tx.workflowStep.findMany({ where: { key: { in: ['print_pattern', 'casting_tree'] } }, select: { id: true, key: true } }),
    );
    const stepId = (key: string) => steps.find((step) => step.key === key)!.id;

    // A move whose transaction began before the pass but waited for the piece's lock: written later, stamped earlier.
    await prisma.inTenant(tenant.id, (tx) =>
      tx.transition.create({
        data: {
          id: newId(),
          workOrderId: piece.id,
          kind: 'correction',
          fromStepId: stepId('casting_tree'),
          toStepId: stepId('print_pattern'),
          fromStatus: 'active',
          toStatus: 'active',
          comment: 'Waited for the lock',
          actorUserId: tenant.ownerId,
          createdAt: new Date(Date.now() - 60 * 60_000),
        },
      }),
    );
    expect((await detail(tenant, piece)).history.map((row) => row.kind)).toEqual(['pass', 'correction']);
  });

  it('leaves transitions as they were written, even for the application', async () => {
    const tenant = await freshTenant();
    const [piece] = await started(tenant, 1);
    await toPolishing(tenant, [piece]);
    await pass(tenant, [piece], 'polishing', { answers: [{ item: 'surface', value: 'ok' }] }).expect(200);
    await pass(tenant, [piece], 'final_qc', { answers: [{ item: 'weight', value: '5.0' }], photo_file_version_ids: [await photo(tenant)] }).expect(
      200,
    );

    // The trigger that refuses even the owner is covered once for every table, in append-only.e2e-spec.ts.
    for (const statement of [
      Prisma.sql`UPDATE transition SET comment = 'changed'`,
      Prisma.sql`DELETE FROM transition`,
      Prisma.sql`UPDATE transition_answer SET value = '9'`,
      Prisma.sql`DELETE FROM transition_answer`,
      Prisma.sql`DELETE FROM transition_photo`,
    ]) {
      await expect(prisma.inTenant(tenant.id, (tx) => tx.$executeRaw(statement))).rejects.toThrow(/permission denied/i);
    }
    expect((await detail(tenant, piece)).history).toHaveLength(5);
  });

  it('keeps moves to staff who may move pieces, within the limits', async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant, 2);

    await tenant.customer.post('/workflow/moves', { work_order_ids: ids(pieces), at_step: 'print_pattern', kind: 'pass' }).expect(403);
    await tenant.member.post('/workflow/moves', { work_order_ids: ids(pieces), at_step: 'print_pattern', kind: 'pass' }).expect(200);

    const body = { work_order_ids: ids(pieces), at_step: 'casting_tree', kind: 'pass' };
    await move(tenant, { ...body, work_order_ids: [] }).expect(400);
    await move(tenant, { ...body, work_order_ids: Array.from({ length: 1001 }, () => newId()) }).expect(400);
    await move(tenant, { ...body, work_order_ids: [pieces[0].id, pieces[0].id] }).expect(400);
    await move(tenant, { ...body, photo_file_version_ids: Array.from({ length: 21 }, () => newId()) }).expect(400);
    await move(tenant, { ...body, kind: 'scrap' }).expect(400);
    await move(tenant, { ...body, at_step: undefined }).expect(400);
    await move(tenant, { ...body, comment: 'x'.repeat(2001) }).expect(400);
    await move(tenant, { ...body, to_step: 'casting' }).expect(400);
    await move(tenant, { work_order_ids: ids(pieces), kind: 'correction', comment: 'Wrong tray' }).expect(400);
    expect(await stepOf(tenant, pieces[0])).toBe('casting_tree');
  });
});
