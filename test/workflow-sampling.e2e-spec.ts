import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { ReportsService } from '../src/modules/reporting/reports.service';
import { sampling } from '../src/modules/workflow/sampling';
import {
  moveResponseSchema,
  transitionListItemSchema,
  workOrderDetailResponseSchema,
  workOrderListItemSchema,
} from '../src/modules/workflow/work-order-response';
import { workflowVersionResponseSchema } from '../src/modules/workflow/workflow-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Piece {
  id: string;
  group_id: string;
  number: number;
  label: string;
  status: string;
  step: { key: string } | null;
  replaces_id: string | null;
  to_inspect: boolean | null;
}
interface Transition {
  kind: string;
  inspected: boolean;
  answers: unknown[];
  work_order: { id: string };
}

const WAITING = 'Waiting for the sample to pass';

/**
 * Workflow 2, Task 3. The cast workflow gets an in-house "Inspection" step after polishing that inspects
 * 2 of every 10 pieces: a required yes/no "Looks right", scratch (continue) and crack (scrap). Polished
 * silver runs print pattern → casting tree → casting → polishing → inspection → final QC → packing.
 */
describe('workflow: a step inspects a random sample', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let reports: ReportsService;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;
  const random = sampling.random;

  const http = () => request(app.getHttpServer());
  const id = (response: request.Response) => (response.body as { id: string }).id;

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const staff = {
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    };
    const setup = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    const inspectionType = id(
      await staff.post('/pricing/step-types', { key: 'inspection', name: 'Inspection', position: 46, summary_group: null }).expect(201),
    );
    const version = await setup.workflow.setSteps([
      {
        key: 'inspection',
        name: 'Inspection',
        step_type_id: inspectionType,
        done_by: 'workspace',
        checklist: [{ key: 'looks_ok', label: 'Looks right', required: true, kind: 'yes_no', passing_answer: true }],
        defects: [
          { defect_id: setup.workflow.defects.scratch, outcome: 'continue' },
          { defect_id: setup.workflow.defects.crack, outcome: 'scrap' },
        ],
        sampling: { inspect: 2, of_every: 10 },
      },
    ]);
    expectDocumented(workflowVersionResponseSchema, version.body);
    expect((version.body as { steps: { key: string; sampling: unknown }[] }).steps.find((step) => step.key === 'inspection')).toMatchObject({
      sampling: { inspect: 2, of_every: 10 },
    });
    return { id: tenant.id, setup, staff };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** Starts a polished silver quote of `quantity` pieces; returns them in number order. */
  async function started(tenant: Tenant, quantity = 10): Promise<Piece[]> {
    const quoted = await tenant.staff
      .post('/pricing/quotes', {
        product_id: tenant.setup.productId,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        file_version_id: tenant.setup.versionId,
        quantity,
      })
      .expect(201);
    const quoteId = (quoted.body as { quote: { id: string } }).quote.id;
    await tenant.staff.post('/workflow/groups', { quote_id: quoteId }).expect(201);
    return listGroup(tenant, quoteId);
  }

  async function listGroup(tenant: Tenant, quoteId?: string, groupId?: string): Promise<Piece[]> {
    let group = groupId;
    if (!group) {
      group = await prisma.inTenant(tenant.id, async (tx) =>
        (await tx.workOrderGroup.findFirstOrThrow({ where: { sourceType: 'quote', sourceId: quoteId } })).id,
      );
    }
    const listed = await tenant.staff.get(`/workflow/work-orders?group_id=${group}&limit=100`).expect(200);
    expectDocumented(pageSchema(workOrderListItemSchema), listed.body);
    return (listed.body as { data: Piece[] }).data;
  }
  const reread = (tenant: Tenant, pieces: Piece[]) => listGroup(tenant, undefined, pieces[0]!.group_id);
  const live = (pieces: Piece[]) => pieces.filter((piece) => piece.status === 'active');

  const ids = (pieces: Piece[]) => pieces.map((piece) => piece.id);
  const move = (tenant: Tenant, body: object) => tenant.staff.post('/workflow/moves', body);
  const pass = (tenant: Tenant, pieces: Piece[], atStep: string, extra: object = {}) =>
    move(tenant, { work_order_ids: ids(pieces), at_step: atStep, kind: 'pass', ...extra });
  const inspect = (tenant: Tenant, pieces: Piece[]) =>
    pass(tenant, pieces, 'inspection', { answers: [{ item: 'looks_ok', value: true }] });
  const passUninspected = (tenant: Tenant, pieces: Piece[]) => pass(tenant, pieces, 'inspection', { inspected: false });

  /** Passes the pieces from print pattern through polishing, so they wait at inspection. */
  async function toInspection(tenant: Tenant, pieces: Piece[]) {
    for (const step of ['print_pattern', 'casting_tree', 'casting']) {
      await pass(tenant, pieces, step).expect(200);
    }
    await pass(tenant, pieces, 'polishing', { answers: [{ item: 'surface', value: 'ok' }] }).expect(200);
  }

  const drawn = (pieces: Piece[]) => pieces.filter((piece) => piece.to_inspect === true);
  const undrawn = (pieces: Piece[]) => pieces.filter((piece) => piece.to_inspect === false);
  const draws = (tenant: Tenant) =>
    prisma.inTenant(tenant.id, (tx) => tx.sampleDraw.findMany({ include: { pieces: true } }));
  const detail = (response: request.Response) => (response.body as { detail: string }).detail;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    reports = moduleRef.get(ReportsService);
  });

  afterEach(() => {
    sampling.random = random;
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('draws 2 of 10 and marks them to inspect', async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    // Before the sampling step, nothing is to inspect or not: the step they are at doesn't sample.
    expect(pieces.every((piece) => piece.to_inspect === null)).toBe(true);

    // Half arrive first: the draw is made then, from all ten live pieces, wherever they are.
    await toInspection(tenant, pieces.slice(0, 5));
    const [first] = await draws(tenant);
    expect(first?.pieces).toHaveLength(2);
    expect(first?.endedAt).toBeNull();

    // A later arrival draws nothing new.
    await toInspection(tenant, pieces.slice(5));
    const [again] = await draws(tenant);
    expect(again?.id).toBe(first?.id);
    expect(again?.pieces.map((piece) => piece.workOrderId).sort()).toEqual(first?.pieces.map((piece) => piece.workOrderId).sort());

    const now = await reread(tenant, pieces);
    expect(drawn(now)).toHaveLength(2);
    expect(undrawn(now)).toHaveLength(8);
    expect(ids(drawn(now)).sort()).toEqual(first?.pieces.map((piece) => piece.workOrderId).sort());

    const one = await tenant.staff.get(`/workflow/work-orders/${drawn(now)[0]!.id}`).expect(200);
    expectDocumented(workOrderDetailResponseSchema, one.body);
    expect(one.body).toMatchObject({ to_inspect: true });
  });

  it('uses the random source to pick the pieces, in number order', async () => {
    sampling.random = (max) => max - 1;
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    await toInspection(tenant, pieces);

    expect(drawn(await reread(tenant, pieces)).map((piece) => piece.number)).toEqual([9, 10]);
  });

  it('refuses uninspected passes until the sample passes, then passes the rest in one move', async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    await toInspection(tenant, pieces);
    const now = await reread(tenant, pieces);
    const [sample, rest] = [drawn(now), undrawn(now)];

    const waiting = await passUninspected(tenant, rest).expect(409);
    expect(detail(waiting)).toBe(WAITING);
    // A drawn piece is always inspected.
    await passUninspected(tenant, sample.slice(0, 1)).expect(409);
    // Not inspected means no answers and no photos.
    await pass(tenant, rest, 'inspection', { inspected: false, answers: [{ item: 'looks_ok', value: true }] }).expect(400);
    // Staff may still inspect any piece in full.
    await inspect(tenant, rest.slice(0, 1)).expect(200);

    await inspect(tenant, sample).expect(200);
    const moved = await passUninspected(tenant, rest.slice(1)).expect(200);
    expectDocumented(moveResponseSchema, moved.body);
    expect((moved.body as { data: Piece[] }).data.every((piece) => piece.step?.key === 'final_qc')).toBe(true);

    const history = await tenant.staff
      .get(`/workflow/transitions?group_id=${pieces[0]!.group_id}&step_key=inspection&inspected=false&limit=100`)
      .expect(200);
    expectDocumented(pageSchema(transitionListItemSchema), history.body);
    const uninspected = (history.body as { data: Transition[] }).data;
    expect(uninspected.map((row) => row.work_order.id).sort()).toEqual(ids(rest.slice(1)).sort());
    expect(uninspected.every((row) => row.kind === 'pass' && !row.inspected && row.answers.length === 0)).toBe(true);

    const inspectedRows = await tenant.staff
      .get(`/workflow/transitions?group_id=${pieces[0]!.group_id}&step_key=inspection&inspected=true&limit=100`)
      .expect(200);
    expect((inspectedRows.body as { data: Transition[] }).data).toHaveLength(3);
  });

  it('turns sampling off for the batch after any fail', async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    await toInspection(tenant, pieces);
    const now = await reread(tenant, pieces);
    const [sample, rest] = [drawn(now), undrawn(now)];
    await inspect(tenant, sample).expect(200);

    // A fail of a piece nobody drew still ends sampling for the group at this step.
    const failed = rest[0]!;
    await move(tenant, {
      work_order_ids: [failed.id],
      at_step: 'inspection',
      kind: 'fail',
      defect_id: tenant.setup.workflow.defects.scratch,
    }).expect(200);

    const [draw] = await draws(tenant);
    expect(draw?.endedAt).not.toBeNull();
    const fail = await prisma.inTenant(tenant.id, (tx) =>
      tx.transition.findFirstOrThrow({ where: { workOrderId: failed.id, kind: 'fail' } }),
    );
    expect(draw?.endedByTransitionId).toBe(fail.id);

    const after = live(await reread(tenant, pieces)).filter((piece) => piece.step?.key === 'inspection');
    expect(after).toHaveLength(7);
    expect(after.every((piece) => piece.to_inspect === true)).toBe(true);
    await passUninspected(tenant, after).expect(409);
    await inspect(tenant, after).expect(200);
  });

  it("hands a scrapped sample's place to its replacement (Review Focus 1)", async () => {
    // The random source always takes the first piece left, so pieces 1 and 2 are drawn.
    sampling.random = () => 0;
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    const [one, two] = pieces as [Piece, Piece];
    const others = pieces.slice(2);

    // Piece 10 arrives first and the draw is made; pieces 1 and 2 are drawn while still at polishing.
    await toInspection(tenant, pieces.slice(9));
    for (const step of ['print_pattern', 'casting_tree', 'casting']) {
      await pass(tenant, pieces.slice(0, 9), step).expect(200);
    }
    // At polishing, which doesn't sample, no piece is marked either way.
    const atPolishing = (await reread(tenant, pieces)).filter((piece) => piece.step?.key === 'polishing');
    expect(atPolishing.every((piece) => piece.to_inspect === null)).toBe(true);
    const [draw] = await draws(tenant);
    expect(draw?.pieces.map((piece) => piece.workOrderId).sort()).toEqual([one.id, two.id].sort());

    // Piece 1 cracks at polishing and is scrapped; its replacement starts again at print pattern.
    await move(tenant, {
      work_order_ids: [one.id],
      at_step: 'polishing',
      kind: 'fail',
      defect_id: tenant.setup.workflow.defects.crack,
      comment: 'Cracked through',
    }).expect(200);
    await pass(tenant, [two, ...others.slice(0, 7)], 'polishing', { answers: [{ item: 'surface', value: 'ok' }] }).expect(200);

    // Piece 2 passes; the rest still wait for the replacement of piece 1.
    await inspect(tenant, [two]).expect(200);
    const rest = live(await reread(tenant, pieces)).filter((piece) => piece.step?.key === 'inspection' && piece.id !== two.id);
    expect(rest).toHaveLength(8);
    const waiting = await passUninspected(tenant, rest).expect(409);
    expect(detail(waiting)).toBe(WAITING);

    const replacement = live(await reread(tenant, pieces)).find((piece) => piece.replaces_id === one.id)!;
    await toInspection(tenant, [replacement]);
    const arrived = (await reread(tenant, pieces)).find((piece) => piece.id === replacement.id)!;
    expect(arrived).toMatchObject({ step: { key: 'inspection' }, to_inspect: true });
    await passUninspected(tenant, [arrived]).expect(409);
    await inspect(tenant, [arrived]).expect(200);

    // The draw itself is never changed.
    const [unchanged] = await draws(tenant);
    expect(unchanged?.pieces.map((piece) => piece.workOrderId).sort()).toEqual([one.id, two.id].sort());
    await passUninspected(tenant, rest).expect(200);
  });

  it('inspects a reworked piece and a replacement in full (Review Focus 2)', async () => {
    sampling.random = () => 0;
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    await toInspection(tenant, pieces);
    await inspect(tenant, pieces.slice(0, 2)).expect(200);
    await passUninspected(tenant, pieces.slice(2)).expect(200);
    const [three, four] = pieces.slice(2, 4) as [Piece, Piece];

    // Piece 3 fails final QC with a scratch and goes back to polishing; passed there, it reaches
    // inspection while its rework is still open.
    await move(tenant, {
      work_order_ids: [three.id],
      at_step: 'final_qc',
      kind: 'fail',
      defect_id: tenant.setup.workflow.defects.scratch,
    }).expect(200);
    await pass(tenant, [three], 'polishing', { answers: [{ item: 'surface', value: 'ok' }] }).expect(200);

    // Piece 4 fails final QC and is scrapped instead; its replacement goes round again.
    await move(tenant, {
      work_order_ids: [four.id],
      at_step: 'final_qc',
      kind: 'fail',
      defect_id: tenant.setup.workflow.defects.scratch,
      outcome: 'scrap',
      override_reason: 'Too deep to polish out',
    }).expect(200);
    const replacement = live(await reread(tenant, pieces)).find((piece) => piece.replaces_id === four.id)!;
    await toInspection(tenant, [replacement]);

    const now = live(await reread(tenant, pieces)).filter((piece) => piece.step?.key === 'inspection');
    expect(ids(now).sort()).toEqual([three.id, replacement.id].sort());
    expect(now.every((piece) => piece.to_inspect === true)).toBe(true);
    for (const piece of now) {
      const refused = await passUninspected(tenant, [piece]).expect(409);
      expect(detail(refused)).toMatch(/inspect/i);
    }
    await inspect(tenant, now).expect(200);
  });

  it('leaves uninspected passes out of the defect rate', async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    await toInspection(tenant, pieces);
    const now = await reread(tenant, pieces);
    await inspect(tenant, drawn(now)).expect(200);
    await passUninspected(tenant, undrawn(now)).expect(200);
    await move(tenant, {
      work_order_ids: [pieces[0]!.id],
      at_step: 'final_qc',
      kind: 'fail',
      defect_id: tenant.setup.workflow.defects.scratch,
    }).expect(200);

    await reports.refresh(tenant.id, new Date());
    const dashboard = await tenant.staff.get('/reports/dashboard').expect(200);
    // 40 passes before inspection, 2 inspected passes there and 1 fail with a defect: 1 in 43. The 8
    // passes nobody inspected never had a chance to find a defect.
    const rate = (dashboard.body as { current: { production: { defect_rate: number } } }).current.production.defect_rate;
    expect(rate).toBeCloseTo(1 / 43, 6);
  });
});
