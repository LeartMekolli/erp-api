import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { groupResponseSchema } from '../src/modules/workflow/work-order-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Piece {
  id: string;
  number: number;
  label: string;
  status: string;
  step: { key: string } | null;
  replaces_id: string | null;
}
interface Group {
  pieces: { active: number; finished: number; scrapped: number };
  steps: { key: string; name: string; count: number; in_rework: number }[];
}

describe('workflow: scrap, replacement and rework', () => {
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
    const as = (token: string) => ({
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    });
    const ownerClient = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const setup = await pricedCastPart(ownerClient, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    return { id: tenant.id, setup, owner: ownerClient };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** Starts 10 polished silver pieces; returns the group id and the pieces in number order. */
  async function started(tenant: Tenant) {
    const quoted = await tenant.owner
      .post('/pricing/quotes', {
        product_id: tenant.setup.productId,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        file_version_id: tenant.setup.versionId,
        quantity: 10,
      })
      .expect(201);
    const quoteId = (quoted.body as { quote: { id: string } }).quote.id;
    const groupId = ((await tenant.owner.post('/workflow/groups', { quote_id: quoteId }).expect(201)).body as { id: string }).id;
    return { groupId, pieces: await list(tenant, `group_id=${groupId}`) };
  }

  const list = async (tenant: Tenant, query: string) =>
    ((await tenant.owner.get(`/workflow/work-orders?${query}&limit=100`).expect(200)).body as { data: Piece[] }).data;
  const piece = async (tenant: Tenant, id: string) =>
    (await tenant.owner.get(`/workflow/work-orders/${id}`).expect(200)).body as Piece & { history: { kind: string }[] };
  const group = async (tenant: Tenant, id: string) => {
    const response = await tenant.owner.get(`/workflow/groups/${id}`).expect(200);
    expectDocumented(groupResponseSchema, response.body);
    return response.body as Group;
  };
  const move = (tenant: Tenant, body: object) => tenant.owner.post('/workflow/moves', body);
  const pass = (tenant: Tenant, ids: string[], atStep: string, extra: object = {}) =>
    move(tenant, { work_order_ids: ids, at_step: atStep, kind: 'pass', ...extra });
  const scrap = (tenant: Tenant, id: string) =>
    move(tenant, { work_order_ids: [id], at_step: 'casting', kind: 'fail', defect_id: tenant.setup.workflow.defects.crack });
  const restore = (tenant: Tenant, id: string) =>
    move(tenant, { work_order_ids: [id], kind: 'correction', to_step: 'casting', comment: 'The crack was a mould mark' });

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

  it('scraps a piece and starts its replacement at the first step, under the same number', async () => {
    const tenant = await freshTenant();
    const { groupId, pieces } = await started(tenant);
    const ids = pieces.map((one) => one.id);
    await pass(tenant, ids, 'print_pattern').expect(200);
    await pass(tenant, ids, 'casting_tree').expect(200);

    const scrapped = await scrap(tenant, pieces[3].id).expect(200);
    expect((scrapped.body as { data: Piece[] }).data).toEqual([expect.objectContaining({ label: '4/10', status: 'scrapped', step: null })]);
    expect((await piece(tenant, pieces[3].id)).history.at(-1)).toMatchObject({
      kind: 'fail',
      outcome: 'scrap',
      from_step: { key: 'casting' },
      to_step: null,
      defect: { key: 'crack' },
    });

    const [replacement] = (await list(tenant, `group_id=${groupId}`)).filter((one) => one.replaces_id === pieces[3].id);
    expect(replacement).toMatchObject({ number: 4, label: '4/10', status: 'active', step: { key: 'print_pattern' } });
    expect((await piece(tenant, replacement.id)).history).toEqual([]);

    const progress = await group(tenant, groupId);
    expect(progress.pieces).toEqual({ active: 10, finished: 0, scrapped: 1 });
    expect(progress.steps.find((step) => step.key === 'print_pattern')).toMatchObject({ count: 1 });
    expect(progress.steps.find((step) => step.key === 'casting')).toMatchObject({ count: 9 });

    // A scrapped piece stays where it stopped.
    await pass(tenant, [pieces[3].id], 'casting').expect(409);
  });

  it('restores a mistaken scrap while the replacement is untouched, and cancels the replacement', async () => {
    const tenant = await freshTenant();
    const { groupId, pieces } = await started(tenant);
    const ids = pieces.map((one) => one.id);
    await pass(tenant, ids, 'print_pattern').expect(200);
    await pass(tenant, ids, 'casting_tree').expect(200);
    await scrap(tenant, pieces[3].id).expect(200);
    const [replacement] = (await list(tenant, 'status=active')).filter((one) => one.replaces_id === pieces[3].id);

    // Restoring a piece cancels its replacement, so one correction can't also move that replacement.
    const both = await move(tenant, {
      work_order_ids: [pieces[3].id, replacement.id],
      kind: 'correction',
      to_step: 'casting',
      comment: 'The crack was a mould mark',
    }).expect(409);
    expect(((both.body as { errors: { path: string }[] }).errors ?? []).map((error) => error.path)).toEqual(['work_order_ids.1']);
    expect(await piece(tenant, replacement.id)).toMatchObject({ status: 'active', step: { key: 'print_pattern' } });

    await restore(tenant, pieces[3].id).expect(200);
    expect(await piece(tenant, pieces[3].id)).toMatchObject({ status: 'active', step: { key: 'casting' } });
    expect((await piece(tenant, pieces[3].id)).history.at(-1)).toMatchObject({
      kind: 'correction',
      from_step: null,
      to_step: { key: 'casting' },
    });
    expect(await piece(tenant, replacement.id)).toMatchObject({ status: 'cancelled', step: null });
    expect((await group(tenant, groupId)).pieces).toEqual({ active: 10, finished: 0, scrapped: 0 });

    // A cancelled piece never moves again.
    await pass(tenant, [replacement.id], 'print_pattern').expect(409);
    await move(tenant, { work_order_ids: [replacement.id], kind: 'correction', to_step: 'casting', comment: 'Back again' }).expect(409);

    // The restored piece is an ordinary piece: it can be scrapped again, and gets a second replacement.
    await scrap(tenant, pieces[3].id).expect(200);
    const replacements = (await list(tenant, `group_id=${groupId}`)).filter((one) => one.replaces_id === pieces[3].id);
    expect(replacements.map((one) => one.status).sort()).toEqual(['active', 'cancelled']);
  });

  it('lets a scrap stand once the replacement has moved', async () => {
    const tenant = await freshTenant();
    const { groupId, pieces } = await started(tenant);
    const ids = pieces.map((one) => one.id);
    await pass(tenant, ids, 'print_pattern').expect(200);
    await pass(tenant, ids, 'casting_tree').expect(200);
    await scrap(tenant, pieces[3].id).expect(200);
    const [replacement] = (await list(tenant, 'status=active')).filter((one) => one.replaces_id === pieces[3].id);
    await pass(tenant, [replacement.id], 'print_pattern').expect(200);

    await restore(tenant, pieces[3].id).expect(409);
    expect(await piece(tenant, pieces[3].id)).toMatchObject({ status: 'scrapped', step: null });
    expect(await piece(tenant, replacement.id)).toMatchObject({ status: 'active', step: { key: 'casting_tree' } });
    expect((await group(tenant, groupId)).pieces).toEqual({ active: 10, finished: 0, scrapped: 1 });
  });

  it('counts pieces in rework until they pass the step they failed at', async () => {
    const tenant = await freshTenant();
    const { groupId, pieces } = await started(tenant);
    const ids = pieces.map((one) => one.id);
    for (const step of ['print_pattern', 'casting_tree', 'casting']) {
      await pass(tenant, ids, step).expect(200);
    }
    const failed = ids.slice(0, 3);
    await move(tenant, {
      work_order_ids: failed,
      at_step: 'polishing',
      kind: 'fail',
      defect_id: tenant.setup.workflow.defects.porosity,
      comment: 'Pores under the surface',
    }).expect(200);

    const at = async (key: string) => (await group(tenant, groupId)).steps.find((step) => step.key === key);
    expect(await at('casting')).toEqual({ key: 'casting', name: 'Casting', count: 3, in_rework: 3 });
    expect(await at('polishing')).toEqual({ key: 'polishing', name: 'Polishing', count: 7, in_rework: 0 });

    // Still in rework after casting again: it failed at polishing.
    await pass(tenant, failed, 'casting').expect(200);
    expect(await at('polishing')).toMatchObject({ count: 10, in_rework: 3 });

    // A correction neither opens nor closes a rework.
    await move(tenant, { work_order_ids: [failed[0]], kind: 'correction', to_step: 'casting', comment: 'Wrong tray' }).expect(200);
    expect(await at('casting')).toMatchObject({ count: 1, in_rework: 1 });
    await pass(tenant, [failed[0]], 'casting').expect(200);

    await pass(tenant, failed, 'polishing', { answers: [{ item: 'surface', value: 'ok' }] }).expect(200);
    expect(await at('final_qc')).toEqual({ key: 'final_qc', name: 'Final QC', count: 3, in_rework: 0 });
    expect(await at('polishing')).toMatchObject({ count: 7, in_rework: 0 });
  });
});
