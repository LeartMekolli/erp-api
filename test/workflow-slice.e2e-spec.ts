import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { customerViewResponseSchema, groupResponseSchema } from '../src/modules/workflow/work-order-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Piece {
  id: string;
  label: string;
  status: string;
  step: { key: string } | null;
  replaces_id: string | null;
}
interface Group {
  id: string;
  workflow: { version: number };
  pieces: { active: number; finished: number; scrapped: number };
  steps: { key: string; count: number; in_rework: number }[];
}
interface CustomerPiece {
  label: string;
  stage: string | null;
  redone: boolean;
  restarted: boolean;
  finished: boolean;
}

/**
 * The Workflow/QC spec's "Done when", steps 1–9, through the API as staff, as in Swagger. The cast
 * part and its "Cast rings" workflow come from `pricedCastPart`; design files and photos are written
 * straight to the database, already uploaded.
 */
describe('workflow: the done-when walkthrough', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());

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

  it('runs 10 pieces through the cast workflow behind the QC gate, and shows customers only progress', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const customer = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, (tx) => tx.user.update({ where: { id: customer.id }, data: { kind: 'customer' } }));
    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const staff = {
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    };
    const photo = async () => (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;

    // 1. The defect catalogue and "Cast rings" with its checks, rework targets, evidence rules and customer names.
    const setup = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    const { defects } = setup.workflow;

    // 2. Ten pieces from a saved quote, all at the first step.
    const quote = async () => {
      const quoted = await staff
        .post('/pricing/quotes', {
          product_id: setup.productId,
          options: { material: 'silver_925', finish: 'polished' },
          size: { scale: '1.5' },
          file_version_id: setup.versionId,
          quantity: 10,
        })
        .expect(201);
      return (quoted.body as { quote: { id: string } }).quote.id;
    };
    const group = (await staff.post('/workflow/groups', { quote_id: await quote() }).expect(201)).body as Group;
    const groupView = async () => {
      const response = await staff.get(`/workflow/groups/${group.id}`).expect(200);
      expectDocumented(groupResponseSchema, response.body);
      return response.body as Group;
    };
    const at = async (key: string) => (await groupView()).steps.find((step) => step.key === key);
    const pieces = async (query = '') =>
      ((await staff.get(`/workflow/work-orders?group_id=${group.id}&limit=100${query}`).expect(200)).body as { data: Piece[] }).data;
    const all = (await pieces()).map((piece) => piece.id);
    expect(await at('print_pattern')).toMatchObject({ count: 10 });

    const move = (body: object) => staff.post('/workflow/moves', body);
    const pass = (ids: string[], atStep: string, extra: object = {}) => move({ work_order_ids: ids, at_step: atStep, kind: 'pass', ...extra });

    // 3. All ten pass at once; each piece has its own row.
    for (const step of ['print_pattern', 'casting_tree', 'casting']) {
      await pass(all, step).expect(200);
    }
    const rows = (await staff.get(`/workflow/transitions?group_id=${group.id}&limit=200`).expect(200)).body as { data: unknown[] };
    expect(rows.data).toHaveLength(30);

    // 4. Three fail at polishing with a scratch and go back to it; the other seven move on.
    const [scratched, kept] = [all.slice(0, 3), all.slice(3)];
    await move({
      work_order_ids: scratched,
      at_step: 'polishing',
      kind: 'fail',
      defect_id: defects.scratch,
      answers: [{ item: 'surface', value: 'pitted' }],
      comment: 'Drum left deep marks',
      photo_file_version_ids: [await photo()],
    }).expect(200);
    await pass(kept, 'polishing', { answers: [{ item: 'surface', value: 'ok' }] }).expect(200);
    expect(await at('final_qc')).toMatchObject({ count: 7, in_rework: 0 });
    expect(await at('polishing')).toMatchObject({ count: 3, in_rework: 3 });

    // 5. A pass missing a required answer or photo is refused, naming what's missing.
    const refused = await pass(kept, 'final_qc', { answers: [{ item: 'weight', value: '5.0' }] }).expect(400);
    expect((refused.body as { errors: { path: string }[] }).errors.map((error) => error.path)).toEqual(['photos']);
    const unweighed = await pass(kept, 'final_qc', { photo_file_version_ids: [await photo()] }).expect(400);
    expect((unweighed.body as { errors: { path: string }[] }).errors.map((error) => error.path)).toEqual(['weight']);
    await pass(kept, 'final_qc', { answers: [{ item: 'weight', value: '5.0' }], photo_file_version_ids: [await photo()] }).expect(200);
    expect(await at('packing')).toMatchObject({ count: 7 });

    // 6. One of the scratched pieces cracks: scrapped, and its replacement starts at the first step.
    await move({
      work_order_ids: [scratched[0]],
      at_step: 'polishing',
      kind: 'fail',
      defect_id: defects.crack,
      comment: 'Cracked through the shank',
    }).expect(200);
    const [replacement] = (await pieces('&status=active')).filter((piece) => piece.replaces_id === scratched[0]);
    expect(replacement).toMatchObject({ label: '1/10', step: { key: 'print_pattern' } });
    const afterScrap = await groupView();
    expect(afterScrap.pieces).toEqual({ active: 10, finished: 0, scrapped: 1 });
    await pass([replacement.id], 'print_pattern').expect(200);
    await pass([replacement.id], 'casting_tree').expect(200);

    // 7. A piece passed to packing by mistake goes back to final QC; both rows stay, and it isn't rework.
    await move({ work_order_ids: [kept[0]], kind: 'correction', to_step: 'final_qc', comment: 'Weighed on the wrong scale' }).expect(200);
    const corrected = (await staff.get(`/workflow/work-orders/${kept[0]}`).expect(200)).body as {
      history: { kind: string; to_step: { key: string } | null }[];
    };
    expect(corrected.history.slice(-2).map((row) => `${row.kind}>${row.to_step?.key}`)).toEqual(['pass>packing', 'correction>final_qc']);
    expect(await at('final_qc')).toEqual({ key: 'final_qc', name: 'Final QC', count: 1, in_rework: 0 });

    // 8. An edited workflow is a new version: this group stays on version 1, a new group gets version 2.
    await setup.workflow.setSteps();
    expect((await groupView()).workflow.version).toBe(1);
    const newer = (await staff.post('/workflow/groups', { quote_id: await quote() }).expect(201)).body as Group;
    expect(newer.workflow.version).toBe(2);

    // 9. What a customer would see: customer names and plain flags, nothing internal.
    const view = await staff.get(`/workflow/groups/${group.id}/customer-view`).expect(200);
    expectDocumented(customerViewResponseSchema, view.body);
    const shown = (view.body as { pieces: CustomerPiece[] }).pieces;
    expect(shown).toHaveLength(10);
    expect(shown.find((piece) => piece.label === '1/10')).toEqual({
      label: '1/10',
      stage: 'Casting',
      redone: false,
      restarted: true,
      finished: false,
    });
    expect(shown.filter((piece) => piece.redone).map((piece) => piece.label)).toEqual(['2/10', '3/10']);
    expect(shown.filter((piece) => piece.redone).every((piece) => piece.stage === 'Finishing')).toBe(true);
    // Packing is hidden, so pieces there still show the last stage a customer may see.
    expect(shown.filter((piece) => piece.stage === 'Quality check')).toHaveLength(7);
    expect(new Set(shown.map((piece) => piece.stage))).toEqual(new Set(['Casting', 'Finishing', 'Quality check']));

    const raw = JSON.stringify(view.body);
    for (const internal of [
      'scratch',
      'crack',
      'pitted',
      'Drum left deep marks',
      'Cracked through the shank',
      'Weighed on the wrong scale',
      'casting_tree',
      'print_pattern',
      'Polishing',
      'Packing',
      'Final QC',
      defects.scratch,
      scratched[0],
    ]) {
      expect({ internal, leaked: raw.includes(internal) }).toEqual({ internal, leaked: false });
    }

    const customerToken = (await tokens.issueForUser(tenant.id, customer.id)).accessToken;
    await http().get(`/workflow/groups/${group.id}/customer-view`).set('Authorization', `Bearer ${customerToken}`).expect(403);
  });
});
