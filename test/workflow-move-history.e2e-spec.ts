import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { moveHistoryResponseSchema } from '../src/modules/workflow/move-history-response';
import type { MoveHistoryResponse } from '../src/modules/workflow/move-history-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Piece {
  id: string;
  number: number;
  replaces_id: string | null;
}

describe("workflow: a line's moves, one action at a time", () => {
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
    const customer = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, (tx) => tx.user.update({ where: { id: customer.id }, data: { kind: 'customer' } }));
    const as = (token: string) => ({
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    });
    const ownerClient = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const setup = await pricedCastPart(ownerClient, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    return {
      id: tenant.id,
      ownerId: owner.id,
      setup,
      owner: ownerClient,
      customer: as((await tokens.issueForUser(tenant.id, customer.id)).accessToken),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** Starts `quantity` polished silver pieces; returns the group id and the pieces in number order. */
  async function started(tenant: Tenant, quantity: number) {
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
    const groupId = ((await tenant.owner.post('/workflow/groups', { quote_id: quoteId }).expect(201)).body as { id: string }).id;
    return { groupId, pieces: await piecesOf(tenant, groupId) };
  }

  const piecesOf = async (tenant: Tenant, groupId: string) =>
    ((await tenant.owner.get(`/workflow/work-orders?group_id=${groupId}&limit=100`).expect(200)).body as { data: Piece[] }).data;
  const ids = (pieces: Piece[]) => pieces.map((piece) => piece.id);
  const move = (tenant: Tenant, body: object) => tenant.owner.post('/workflow/moves', body).expect(200);
  const pass = (tenant: Tenant, pieces: Piece[], atStep: string) => move(tenant, { work_order_ids: ids(pieces), at_step: atStep, kind: 'pass' });

  /** The line's moves, checked against the documented shape. */
  async function moves(tenant: Tenant, groupId: string, query = ''): Promise<MoveHistoryResponse> {
    const response = await tenant.owner.get(`/workflow/groups/${groupId}/moves${query}`).expect(200);
    expectDocumented(moveHistoryResponseSchema, response.body);
    return response.body as MoveHistoryResponse;
  }

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

  it('one action for a 10-piece pass', async () => {
    const tenant = await freshTenant();
    const { groupId, pieces } = await started(tenant, 10);
    await pass(tenant, pieces, 'print_pattern');

    const { data, next_cursor, counts } = await moves(tenant, groupId);
    expect(data).toHaveLength(1);
    const [action] = data;
    expect(action).toMatchObject({
      kind: 'pass',
      outcome: null,
      from_step: { key: 'print_pattern' },
      to_step: { key: 'casting_tree' },
      defect: null,
      comment: null,
      answers: [],
      photos: [],
      actor: { id: tenant.ownerId },
      partner: null,
      inspected: true,
    });
    expect(action.pieces.map((piece) => piece.label)).toEqual(Array.from({ length: 10 }, (_, index) => `${index + 1}/10`));
    expect(action.pieces.map((piece) => piece.id)).toEqual(ids(pieces));
    for (const piece of action.pieces) {
      expect(piece).toMatchObject({ status: 'active', replacement: false, from_step: { key: 'print_pattern' }, to_step: { key: 'casting_tree' } });
    }
    expect(next_cursor).toBeNull();
    expect(counts).toEqual({ all: 1, fails: 0 });

    // The action's id is the move id every row of it carries.
    const rows = (await tenant.owner.get(`/workflow/transitions?group_id=${groupId}`).expect(200)).body as { data: { move_id: string }[] };
    expect(rows.data).toHaveLength(10);
    expect(rows.data.every((row) => row.move_id === action.id)).toBe(true);
  });

  it('pages by action', async () => {
    const tenant = await freshTenant();
    const { groupId, pieces } = await started(tenant, 10);
    await pass(tenant, pieces, 'print_pattern');
    await pass(tenant, pieces, 'casting_tree');

    const first = await moves(tenant, groupId, '?limit=1');
    expect(first.data).toHaveLength(1);
    expect(first.data[0]).toMatchObject({ from_step: { key: 'casting_tree' } });
    expect(first.data[0].pieces).toHaveLength(10);
    expect(first.next_cursor).not.toBeNull();
    expect(first.counts).toEqual({ all: 2, fails: 0 });

    const second = await moves(tenant, groupId, `?limit=1&cursor=${encodeURIComponent(first.next_cursor!)}`);
    expect(second.data).toHaveLength(1);
    expect(second.data[0]).toMatchObject({ from_step: { key: 'print_pattern' } });
    expect(second.data[0].pieces).toHaveLength(10);
    expect(second.data[0].id).not.toBe(first.data[0].id);
    expect(second.next_cursor).toBeNull();
    expect(second.counts).toEqual({ all: 2, fails: 0 });
  });

  it('fails filter and counts', async () => {
    const tenant = await freshTenant();
    const { groupId, pieces } = await started(tenant, 10);
    for (const step of ['print_pattern', 'casting_tree', 'casting']) {
      await pass(tenant, pieces, step);
    }
    const photo = await measuredDesign(prisma, tenant.id, tenant.ownerId, { status: 'uploaded', measures: [] });
    await move(tenant, {
      work_order_ids: ids(pieces.slice(0, 2)),
      at_step: 'polishing',
      kind: 'fail',
      defect_id: tenant.setup.workflow.defects.scratch,
      comment: 'Scratched in the drum',
      answers: [{ item: 'surface', value: 'pitted' }],
      photo_file_version_ids: [photo.versionId],
    });
    await move(tenant, { work_order_ids: [pieces[9].id], kind: 'correction', to_step: 'print_pattern', comment: 'Pattern was warped' });

    const fails = await moves(tenant, groupId, '?only=fails');
    expect(fails.data.map((action) => action.kind)).toEqual(['correction', 'fail']);
    expect(fails.counts).toEqual({ all: 5, fails: 2 });
    expect(fails.next_cursor).toBeNull();

    const [correction, fail] = fails.data;
    expect(correction).toMatchObject({
      from_step: { key: 'polishing' },
      to_step: { key: 'print_pattern' },
      comment: 'Pattern was warped',
      defect: null,
    });
    expect(correction.pieces).toEqual([
      expect.objectContaining({ id: pieces[9].id, label: '10/10', status: 'active', to_step: expect.objectContaining({ key: 'print_pattern' }) }),
    ]);
    expect(fail).toMatchObject({
      outcome: 'rework',
      from_step: { key: 'polishing' },
      to_step: { key: 'polishing' },
      defect: { key: 'scratch', name: 'Scratch' },
      comment: 'Scratched in the drum',
      override_reason: null,
      answers: [{ item: 'surface', label: 'Surface', value: 'pitted', value_label: 'Pitted', note: null, passing: false }],
      photos: [{ file_id: photo.fileId, file_version_id: photo.versionId }],
    });
    expect(fail.pieces.map((piece) => piece.label)).toEqual(['1/10', '2/10']);

    const all = await moves(tenant, groupId);
    expect(all.data.map((action) => action.kind)).toEqual(['correction', 'fail', 'pass', 'pass', 'pass']);
    expect(all.data.map((action) => action.from_step?.key)).toEqual(['polishing', 'polishing', 'casting', 'casting_tree', 'print_pattern']);
    expect(all.counts).toEqual({ all: 5, fails: 2 });
  });

  it('a restore is one action', async () => {
    const tenant = await freshTenant();
    const { groupId, pieces } = await started(tenant, 10);
    await pass(tenant, pieces, 'print_pattern');
    await pass(tenant, pieces, 'casting_tree');
    await move(tenant, { work_order_ids: [pieces[3].id], at_step: 'casting', kind: 'fail', defect_id: tenant.setup.workflow.defects.crack });
    const replacement = (await piecesOf(tenant, groupId)).find((piece) => piece.replaces_id === pieces[3].id)!;
    await move(tenant, { work_order_ids: [pieces[3].id], kind: 'correction', to_step: 'print_pattern', comment: 'The crack was a mould mark' });

    const { data, counts } = await moves(tenant, groupId);
    expect(data).toHaveLength(4);
    const [restore] = data;
    expect(restore).toMatchObject({
      kind: 'correction',
      outcome: null,
      from_step: null,
      // The restored piece lands at print pattern, its replacement nowhere: the pieces differ.
      to_step: null,
      comment: 'The crack was a mould mark',
      answers: [],
      photos: [],
    });
    expect(restore.pieces).toEqual([
      { id: pieces[3].id, label: '4/10', replacement: false, status: 'active', from_step: null, to_step: expect.objectContaining({ key: 'print_pattern' }) },
      { id: replacement.id, label: '4/10', replacement: true, status: 'cancelled', from_step: expect.objectContaining({ key: 'print_pattern' }), to_step: null },
    ]);
    // Two passes, the scrap and the restore; the restore is a fail through the restored piece's step, once.
    expect(counts).toEqual({ all: 4, fails: 2 });
    expect((await moves(tenant, groupId, '?only=fails')).data.map((action) => action.id)).toEqual([restore.id, data[1].id]);
  });

  it('one move across two groups', async () => {
    const tenant = await freshTenant();
    // Both on the workflow's current version, so one move may take pieces of both.
    const first = await started(tenant, 2);
    const second = await started(tenant, 3);
    await pass(tenant, [...first.pieces, ...second.pieces], 'print_pattern');

    const ofFirst = await moves(tenant, first.groupId);
    const ofSecond = await moves(tenant, second.groupId);
    expect(ofFirst.data).toHaveLength(1);
    expect(ofSecond.data).toHaveLength(1);
    expect(ofFirst.data[0].id).toBe(ofSecond.data[0].id);
    expect(ofFirst.data[0].pieces.map((piece) => piece.id)).toEqual(ids(first.pieces));
    expect(ofFirst.data[0].pieces.map((piece) => piece.label)).toEqual(['1/2', '2/2']);
    expect(ofSecond.data[0].pieces.map((piece) => piece.id)).toEqual(ids(second.pieces));
    expect(ofSecond.data[0].pieces.map((piece) => piece.label)).toEqual(['1/3', '2/3', '3/3']);
    expect(ofFirst.counts).toEqual({ all: 1, fails: 0 });
    expect(ofSecond.counts).toEqual({ all: 1, fails: 0 });
  });

  it('unknown group', async () => {
    const tenant = await freshTenant();
    const { groupId } = await started(tenant, 1);
    const other = await freshTenant();

    await tenant.owner.get(`/workflow/groups/${newId()}/moves`).expect(404);
    // Another workspace's group is no group at all.
    await other.owner.get(`/workflow/groups/${groupId}/moves`).expect(404);
    await tenant.customer.get(`/workflow/groups/${groupId}/moves`).expect(403);

    await tenant.owner.get('/workflow/groups/not-a-uuid/moves').expect(400);
    await tenant.owner.get(`/workflow/groups/${groupId}/moves?only=passes`).expect(400);
    await tenant.owner.get(`/workflow/groups/${groupId}/moves?limit=201`).expect(400);
    await tenant.owner.get(`/workflow/groups/${groupId}/moves?cursor=nonsense`).expect(400);
    expect(await moves(tenant, groupId)).toEqual({ data: [], next_cursor: null, counts: { all: 0, fails: 0 } });
  });
});
