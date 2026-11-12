import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { downloadUrlResponseSchema } from '../src/modules/files/file-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { jobAssignmentResponseSchema, partnerJobDetailResponseSchema, partnerMoveHistoryResponseSchema } from '../src/modules/partners/partner-response';
import type { PartnerJobDetailResponse, PartnerMoveHistoryResponse } from '../src/modules/partners/partner-response';
import { moveHistoryResponseSchema } from '../src/modules/workflow/move-history-response';
import type { MoveHistoryResponse } from '../src/modules/workflow/move-history-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { putToSignedUrl } from './storage';

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

/** Not a real image: storage checks only the declared size and type. */
const PHOTO_BYTES = Buffer.from('a QC photo of the pieces');

const STAFF_COMMENT = 'Polished the rest in-house';
const CASTCO_COMMENT = 'Scratched in the drum';
const CASTCO_NOTE = 'Left side';

/**
 * The moves on a partner's job (Move history spec; plan Review Focus 3 and 4): every move on its pieces,
 * its own, the workspace's and a previous partner's, but names and free text only on its own people's.
 */
describe("partners: the moves on a partner's job", () => {
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
  type Person = ReturnType<typeof as>;

  /** A partner person with a name of their own, so a leaked name is found in a response; a member of each partner given. */
  async function partnerPerson(tenantId: string, partnerIds: string[], name: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind: 'partner', name } });
      await tx.organisationMembership.createMany({
        data: partnerIds.map((organisationId) => ({ userId: user.id, organisationType: 'partner', organisationId, role: 'member' })),
      });
    });
    return { id: user.id, name, client: as((await tokens.issueForUser(tenantId, user.id)).accessToken) };
  }

  /**
   * The priced cast part, with packing done in-house; CastCo and MetalWorks approved for the partner
   * steps; Luna's two jobs of 10 silver polished pieces, the first accepted by CastCo, the second only
   * offered to it.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    const { printPattern, castingTree, casting, polishing } = cast.steps;

    // The same steps again, with packing done by the workspace.
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
    const castcoPerson = await partnerPerson(tenant.id, [castco], 'Cora Caster');

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
      const quote = (quoted.body as { quote: { id: string } }).quote;
      const group = ((await staff.post('/workflow/groups', { quote_id: quote.id }).expect(201)).body as { id: string }).id;
      await staff.post(`/partners/jobs/${group}/offer`, { partner_id: castco }).expect(201);
      return group;
    };
    const accepted = await job();
    await castcoPerson.client.post(`/partner-portal/partners/${castco}/jobs/${accepted}/accept`).expect(200);
    const offered = await job();

    return {
      id: tenant.id,
      ownerId: owner.id,
      staff,
      cast,
      castco,
      metalworks,
      accepted,
      offered,
      castcoPerson,
      metalworksPerson: await partnerPerson(tenant.id, [metalworks], 'Milo Metal'),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const movesPath = (partnerId: string, group: string) => `/partner-portal/partners/${partnerId}/jobs/${group}/moves`;

  /** The partner's list of the job's moves, checked against the documented shape. */
  async function partnerMoves(person: Person, partnerId: string, group: string, query = ''): Promise<PartnerMoveHistoryResponse> {
    const response = await person.get(`${movesPath(partnerId, group)}${query}`).expect(200);
    expectDocumented(partnerMoveHistoryResponseSchema, response.body);
    return response.body as PartnerMoveHistoryResponse;
  }

  /** A photo the partner uploads through its own file routes, completed. */
  async function partnerPhoto(person: Person, partnerId: string): Promise<{ fileId: string; versionId: string }> {
    const files = `/partner-portal/partners/${partnerId}/files`;
    const started = await person.post(files, { name: 'qc.jpg', content_type: 'image/jpeg', size: PHOTO_BYTES.length }).expect(201);
    const { file, version, upload } = started.body as {
      file: { id: string };
      version: { id: string };
      upload: { url: string; headers: Record<string, string> };
    };
    const put = await putToSignedUrl(upload.url, PHOTO_BYTES, upload.headers);
    await put.arrayBuffer();
    expect(put.status).toBe(200);
    await person.post(`${files}/${file.id}/versions/${version.id}/complete`).expect(200);
    return { fileId: file.id, versionId: version.id };
  }

  /**
   * CastCo's person passes the 10 pieces through to polishing, and `failer` (CastCo's person unless given)
   * fails 2 there for CastCo; staff pass the other 8 at polishing, a move credited to CastCo.
   */
  async function workedByCastco(tenant: Tenant, failer: Person = tenant.castcoPerson.client) {
    const castcoMoves = `/partner-portal/partners/${tenant.castco}/moves`;
    const detail = await tenant.castcoPerson.client.get(`/partner-portal/partners/${tenant.castco}/jobs/${tenant.accepted}`).expect(200);
    expectDocumented(partnerJobDetailResponseSchema, detail.body);
    const ids = (detail.body as { work_orders: { id: string }[] }).work_orders.map((piece) => piece.id);

    for (const at_step of ['print_pattern', 'casting_tree', 'casting']) {
      await tenant.castcoPerson.client.post(castcoMoves, { work_order_ids: ids, kind: 'pass', at_step }).expect(200);
    }
    const photo = await partnerPhoto(failer, tenant.castco);
    await failer
      .post(castcoMoves, {
        work_order_ids: ids.slice(0, 2),
        kind: 'fail',
        at_step: 'polishing',
        defect_id: tenant.cast.workflow.defects.scratch,
        comment: CASTCO_COMMENT,
        answers: [{ item: 'surface', value: 'pitted', note: CASTCO_NOTE }],
        photo_file_version_ids: [photo.versionId],
      })
      .expect(200);
    await tenant.staff
      .post('/workflow/moves', {
        work_order_ids: ids.slice(2),
        kind: 'pass',
        at_step: 'polishing',
        answers: [{ item: 'surface', value: 'ok' }],
        comment: STAFF_COMMENT,
      })
      .expect(200);
    return { ids, photo };
  }

  /** Then staff move the job to MetalWorks, whose person passes the 8 at final QC with a photo of its own. */
  async function reassigned(tenant: Tenant) {
    const { ids, photo } = await workedByCastco(tenant);
    const moved = await tenant.staff.post(`/partners/jobs/${tenant.accepted}/reassign`, { partner_id: tenant.metalworks }).expect(201);
    expectDocumented(jobAssignmentResponseSchema, moved.body);
    const ownPhoto = await partnerPhoto(tenant.metalworksPerson.client, tenant.metalworks);
    await tenant.metalworksPerson.client
      .post(`/partner-portal/partners/${tenant.metalworks}/moves`, {
        work_order_ids: ids.slice(2),
        kind: 'pass',
        at_step: 'final_qc',
        answers: [{ item: 'weight', value: '5.0' }],
        photo_file_version_ids: [ownPhoto.versionId],
      })
      .expect(200);
    return { ids, photo, reassignedAt: (moved.body as { created_at: string }).created_at };
  }

  beforeAll(async () => {
    // Its own queues: no other suite's worker takes this one's measuring jobs.
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
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

  it('only for a job it holds', async () => {
    const tenant = await freshTenant();
    const castco = tenant.castcoPerson.client;
    const metalworks = tenant.metalworksPerson.client;
    const photoPath = (partnerId: string, group: string) => `${movesPath(partnerId, group)}/${newId()}/photos/${newId()}/url`;

    // Offered to CastCo, not accepted; CastCo's, not MetalWorks'; no job at all.
    for (const [person, partnerId, group] of [
      [castco, tenant.castco, tenant.offered],
      [metalworks, tenant.metalworks, tenant.accepted],
      [castco, tenant.castco, newId()],
    ] as const) {
      await person.get(movesPath(partnerId, group)).expect(404);
      await person.get(photoPath(partnerId, group)).expect(404);
    }

    await partnerMoves(castco, tenant.castco, tenant.accepted);
    await castco.get(`${movesPath(tenant.castco, tenant.accepted)}?only=passes`).expect(400);
    await castco.get(`/partner-portal/partners/${tenant.castco}/jobs/not-a-uuid/moves`).expect(400);
    await castco.get(`${movesPath(tenant.castco, tenant.accepted)}/not-a-uuid/photos/${newId()}/url`).expect(400);
  });

  it('after a reassignment', async () => {
    const tenant = await freshTenant();
    const { photo, reassignedAt } = await reassigned(tenant);
    const metalworks = tenant.metalworksPerson.client;

    const body = await partnerMoves(metalworks, tenant.metalworks, tenant.accepted);
    expect(body.data.map((action) => [action.kind, action.from_step?.key, action.actor.kind])).toEqual([
      ['pass', 'final_qc', 'own'],
      ['pass', 'polishing', 'workspace'],
      ['fail', 'polishing', 'other_partner'],
      ['pass', 'casting', 'other_partner'],
      ['pass', 'casting_tree', 'other_partner'],
      ['pass', 'print_pattern', 'other_partner'],
    ]);
    const [own, staffPass, castcoFail] = body.data;

    // A reassignment is accepted at once, with no answer to an offer: the hand-over is when it was made.
    expect(body.handed_over_at).toBe(reassignedAt);
    expect(new Date(staffPass.created_at).getTime()).toBeLessThanOrEqual(new Date(body.handed_over_at).getTime());
    expect(new Date(body.handed_over_at).getTime()).toBeLessThanOrEqual(new Date(own.created_at).getTime());

    expect(own.actor).toEqual({ kind: 'own', name: tenant.metalworksPerson.name });
    expect(own.pieces).toHaveLength(8);

    // Review Focus 4: staff moved at CastCo's step, credited to CastCo, but the partner reads only "the workspace".
    expect(staffPass.actor).toEqual({ kind: 'workspace', name: null });
    expect(staffPass.comment).toBeNull();
    expect(staffPass.answers).toEqual([{ item: 'surface', label: 'Surface', value: 'ok', value_label: 'Smooth', note: null, passing: true }]);

    // Review Focus 3: what happened and what it needs to fix the pieces, never who or what they wrote.
    expect(castcoFail).toMatchObject({
      actor: { kind: 'other_partner', name: null },
      comment: null,
      override_reason: null,
      outcome: 'rework',
      defect: { key: 'scratch', name: 'Scratch' },
      photos: [{ file_id: photo.fileId, file_version_id: photo.versionId }],
    });
    expect(castcoFail.answers).toEqual([{ item: 'surface', label: 'Surface', value: 'pitted', value_label: 'Pitted', note: null, passing: false }]);
    expect(castcoFail.pieces.map((piece) => piece.label)).toEqual(['1/10', '2/10']);

    // No partner and no user id anywhere; no other name and nothing anyone else wrote.
    for (const action of body.data) {
      expect(action).not.toHaveProperty('partner');
      expect(action.actor).not.toHaveProperty('id');
    }
    const text = JSON.stringify(body);
    for (const secret of [
      tenant.castco,
      tenant.metalworks,
      'CastCo',
      tenant.ownerId,
      tenant.castcoPerson.id,
      tenant.castcoPerson.name,
      tenant.metalworksPerson.id,
      'Test User',
      STAFF_COMMENT,
      CASTCO_COMMENT,
      CASTCO_NOTE,
    ]) {
      expect({ secret, found: text.includes(secret) }).toEqual({ secret, found: false });
    }

    // The same counts as staff read for the line.
    const staffList = await tenant.staff.get(`/workflow/groups/${tenant.accepted}/moves`).expect(200);
    expectDocumented(moveHistoryResponseSchema, staffList.body);
    expect(body.counts).toEqual((staffList.body as MoveHistoryResponse).counts);
    expect(body.counts).toEqual({ all: 6, fails: 1 });
    const fails = await partnerMoves(metalworks, tenant.metalworks, tenant.accepted, '?only=fails');
    expect(fails.data.map((action) => action.id)).toEqual([castcoFail.id]);

    // A page at a time, by action.
    const first = await partnerMoves(metalworks, tenant.metalworks, tenant.accepted, '?limit=1');
    expect(first.data.map((action) => action.id)).toEqual([own.id]);
    const second = await partnerMoves(metalworks, tenant.metalworks, tenant.accepted, `?limit=1&cursor=${encodeURIComponent(first.next_cursor!)}`);
    expect(second.data.map((action) => action.id)).toEqual([staffPass.id]);

    // CastCo no longer holds the job.
    await tenant.castcoPerson.client.get(movesPath(tenant.castco, tenant.accepted)).expect(404);
  });

  it("CastCo's own view before the reassignment", async () => {
    const tenant = await freshTenant();
    await workedByCastco(tenant);

    const body = await partnerMoves(tenant.castcoPerson.client, tenant.castco, tenant.accepted);
    const [staffPass, fail] = body.data;
    expect(fail).toMatchObject({
      kind: 'fail',
      actor: { kind: 'own', name: tenant.castcoPerson.name },
      comment: CASTCO_COMMENT,
      answers: [{ item: 'surface', value: 'pitted', note: CASTCO_NOTE }],
    });
    expect(staffPass).toMatchObject({ kind: 'pass', actor: { kind: 'workspace', name: null }, comment: null });
    // CastCo accepted an offer: the hand-over is its answer, before any move.
    const accepted = await prisma.inTenant(tenant.id, (tx) =>
      tx.jobAssignment.findFirstOrThrow({ where: { groupId: tenant.accepted, partnerId: tenant.castco, status: 'accepted' } }),
    );
    expect(body.handed_over_at).toBe(accepted.respondedAt!.toISOString());
  });

  it('a person of two partners keeps what they wrote for one from the other', async () => {
    const tenant = await freshTenant();
    const both = await partnerPerson(tenant.id, [tenant.castco, tenant.metalworks], 'Bea Both');
    await workedByCastco(tenant, both.client);

    // Before the hand-over, the fail is CastCo's own.
    const before = await partnerMoves(tenant.castcoPerson.client, tenant.castco, tenant.accepted);
    expect(before.data.find((action) => action.kind === 'fail')).toMatchObject({ actor: { kind: 'own', name: both.name }, comment: CASTCO_COMMENT });

    await tenant.staff.post(`/partners/jobs/${tenant.accepted}/reassign`, { partner_id: tenant.metalworks }).expect(201);

    // The move was made for CastCo: MetalWorks reads another workshop's, whoever reads it, the same person included.
    for (const reader of [tenant.metalworksPerson.client, both.client]) {
      const body = await partnerMoves(reader, tenant.metalworks, tenant.accepted);
      const fail = body.data.find((action) => action.kind === 'fail')!;
      expect(fail).toMatchObject({ actor: { kind: 'other_partner', name: null }, comment: null, override_reason: null });
      expect(fail.answers.map((answer) => answer.note)).toEqual([null]);
      const text = JSON.stringify(body);
      for (const secret of [both.id, both.name, CASTCO_COMMENT, CASTCO_NOTE]) {
        expect({ secret, found: text.includes(secret) }).toEqual({ secret, found: false });
      }
    }
  });

  it("each piece's rework and last move, as the partner reads who made it", async () => {
    const tenant = await freshTenant();
    await reassigned(tenant);
    const detail = await tenant.metalworksPerson.client.get(`/partner-portal/partners/${tenant.metalworks}/jobs/${tenant.accepted}`).expect(200);
    expectDocumented(partnerJobDetailResponseSchema, detail.body);
    const pieces = (detail.body as PartnerJobDetailResponse).work_orders;

    // CastCo failed the first two at polishing: being redone, by another workshop, unnamed.
    expect(pieces.slice(0, 2).map((piece) => [piece.in_rework, piece.last_move])).toEqual(
      Array.from({ length: 2 }, () => [
        true,
        {
          kind: 'fail',
          outcome: 'rework',
          from_step: expect.objectContaining({ key: 'polishing' }),
          defect: expect.objectContaining({ key: 'scratch', name: 'Scratch' }),
          actor: { kind: 'other_partner', name: null },
          created_at: expect.any(String),
        },
      ]),
    );
    // MetalWorks passed the other eight at final QC: its own, named.
    for (const piece of pieces.slice(2)) {
      expect(piece).toMatchObject({ in_rework: false, last_move: { kind: 'pass', from_step: { key: 'final_qc' } } });
      expect(piece.last_move!.actor).toEqual({ kind: 'own', name: tenant.metalworksPerson.name });
    }

    for (const secret of [tenant.castco, 'CastCo', tenant.ownerId, tenant.castcoPerson.id, tenant.castcoPerson.name, tenant.metalworksPerson.id, 'Test User', STAFF_COMMENT, CASTCO_COMMENT, CASTCO_NOTE]) {
      expect({ secret, found: detail.text.includes(secret) }).toEqual({ secret, found: false });
    }
  });

  it('an offered job shows no earlier moves', async () => {
    const tenant = await freshTenant();
    const listed = await tenant.staff.get(`/workflow/work-orders?group_id=${tenant.offered}`).expect(200);
    const ids = (listed.body as { data: { id: string }[] }).data.map((piece) => piece.id);
    await tenant.staff.post('/workflow/moves', { work_order_ids: ids, kind: 'pass', at_step: 'print_pattern' }).expect(200);

    const detail = await tenant.castcoPerson.client.get(`/partner-portal/partners/${tenant.castco}/jobs/${tenant.offered}`).expect(200);
    expectDocumented(partnerJobDetailResponseSchema, detail.body);
    const pieces = (detail.body as PartnerJobDetailResponse).work_orders;
    expect(pieces.map((piece) => [piece.step_key, piece.in_rework, piece.last_move])).toEqual(Array.from({ length: 10 }, () => ['casting_tree', false, null]));
  });

  it('photo link', async () => {
    const tenant = await freshTenant();
    const { photo } = await reassigned(tenant);
    const metalworks = tenant.metalworksPerson.client;
    const { data } = await partnerMoves(metalworks, tenant.metalworks, tenant.accepted);
    const castcoFail = data.find((action) => action.kind === 'fail')!;
    const staffPass = data.find((action) => action.actor.kind === 'workspace')!;
    const photoPath = (moveId: string, fileVersionId: string) =>
      `${movesPath(tenant.metalworks, tenant.accepted)}/${moveId}/photos/${fileVersionId}/url`;

    // A photo of a previous partner's move on this job.
    const link = await metalworks.get(photoPath(castcoFail.id, photo.versionId)).expect(200);
    expectDocumented(downloadUrlResponseSchema, link.body);
    expect((link.body as { url: string }).url).toMatch(/^https?:\/\//);

    // Not under another move of the job, and not a real photo of MetalWorks' that is on no move.
    await metalworks.get(photoPath(staffPass.id, photo.versionId)).expect(404);
    const loose = await partnerPhoto(metalworks, tenant.metalworks);
    await metalworks.get(photoPath(castcoFail.id, loose.versionId)).expect(404);
  });
});
