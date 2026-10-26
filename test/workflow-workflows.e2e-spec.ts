import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import {
  productWorkflowResponseSchema,
  workflowResponseSchema,
  workflowSummaryResponseSchema,
  workflowVersionResponseSchema,
} from '../src/modules/workflow/workflow-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Version {
  number: number;
  steps: { key: string; position: number; step_type: { key: string; priced: boolean }; checklist: { key: string }[] }[];
}

describe('workflow: workflows, versions and assignment', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const id = (response: request.Response) => (response.body as { id: string }).id;

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
      delete: (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`),
    });
    return {
      id: tenant.id,
      owner: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken),
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      customer: as((await tokens.issueForUser(tenant.id, customer.id)).accessToken),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** Step types of a casting line, three defects, a category with a product, and a workflow with no version yet. */
  async function setup(tenant: Tenant) {
    const stepType = async (key: string, position: number, summary_group: string | null) =>
      id(await tenant.owner.post('/pricing/step-types', { key, name: key, position, summary_group }).expect(201));
    const types = {
      printPattern: await stepType('print_pattern', 10, 'making'),
      castingTree: await stepType('casting_tree', 20, 'making'),
      casting: await stepType('casting', 30, 'making'),
      polishing: await stepType('polishing', 40, 'finishing'),
      plating: await stepType('plating', 50, 'finishing'),
      finalQc: await stepType('final_qc', 90, null),
      packing: await stepType('packing', 95, null),
    };
    const defect = async (key: string) => id(await tenant.owner.post('/workflow/defects', { key, name: key }).expect(201));
    const defects = { porosity: await defect('porosity'), scratch: await defect('scratch'), crack: await defect('crack') };
    const categoryId = id(await tenant.owner.post('/catalog/categories', { key: 'cast_metal', name: 'Cast metal parts' }).expect(201));
    const productId = id(
      await tenant.owner.post('/catalog/products', { category_id: categoryId, key: 'ring', name: 'Ring', kind: 'custom' }).expect(201),
    );
    const workflowId = id(await tenant.owner.post('/workflow/workflows', { key: 'cast_rings', name: 'Cast rings' }).expect(201));
    return { types, defects, categoryId, productId, workflowId };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  const surface = {
    key: 'surface',
    label: 'Surface',
    required: true,
    kind: 'choice',
    options: [
      { key: 'ok', label: 'Smooth', passing: true },
      { key: 'pitted', label: 'Pitted', passing: false },
    ],
  };

  /** The seven steps of a cast ring, from the wax pattern to packing. */
  const castSteps = ({ types, defects }: Setup, polishingChecklist: object[] = [surface]) => ({
    steps: [
      { key: 'print_pattern', name: 'Print pattern', step_type_id: types.printPattern },
      { key: 'casting_tree', name: 'Casting tree', step_type_id: types.castingTree },
      {
        key: 'casting',
        name: 'Casting',
        step_type_id: types.casting,
        defects: [{ defect_id: defects.crack, outcome: 'scrap' }],
        customer: { visible: true, name: 'Casting' },
        expected_minutes: '45',
      },
      {
        key: 'polishing',
        name: 'Polishing',
        step_type_id: types.polishing,
        checklist: polishingChecklist,
        defects: [
          { defect_id: defects.porosity, outcome: 'rework', rework_to: 'casting' },
          { defect_id: defects.scratch, outcome: 'rework', rework_to: 'polishing' },
        ],
        rework_targets: ['casting', 'polishing'],
        fail: { min_photos: 1, comment_required: true },
        customer: { visible: true, name: 'Finishing' },
      },
      { key: 'plating', name: 'Plating', step_type_id: types.plating },
      {
        key: 'final_qc',
        name: 'Final QC',
        step_type_id: types.finalQc,
        checklist: [{ key: 'weight', label: 'Weight', required: true, kind: 'number', unit: 'g', min: '4.8', max: '5.2' }],
        pass: { min_photos: 1, comment_required: false },
        customer: { visible: true, name: 'Quality check' },
      },
      { key: 'packing', name: 'Packing', step_type_id: types.packing },
    ],
  });

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

  it('creates a workflow and gives it its first version of steps', async () => {
    const tenant = await freshTenant();
    const ids = await setup(tenant);

    const created = await tenant.owner.get(`/workflow/workflows/${ids.workflowId}`).expect(200);
    expectDocumented(workflowResponseSchema, created.body);
    expect(created.body).toMatchObject({ key: 'cast_rings', name: 'Cast rings', current_version: null });

    const version = await tenant.owner.put(`/workflow/workflows/${ids.workflowId}/steps`, castSteps(ids)).expect(200);
    expectDocumented(workflowVersionResponseSchema, version.body);
    const body = version.body as Version;
    expect(body.number).toBe(1);
    expect(body.steps.map((step) => [step.key, step.position, step.step_type.priced])).toEqual([
      ['print_pattern', 0, true],
      ['casting_tree', 1, true],
      ['casting', 2, true],
      ['polishing', 3, true],
      ['plating', 4, true],
      ['final_qc', 5, false],
      ['packing', 6, false],
    ]);
    expect(body.steps[3]).toMatchObject({
      checklist: [{ key: 'surface' }],
      defects: [
        { key: 'porosity', outcome: 'rework', rework_to: 'casting' },
        { key: 'scratch', outcome: 'rework', rework_to: 'polishing' },
      ],
      rework_targets: ['casting', 'polishing'],
      fail: { min_photos: 1, comment_required: true },
      customer: { visible: true, name: 'Finishing' },
    });
    expect(body.steps[2]).toMatchObject({ expected_minutes: '45', sop_file_version_id: null });

    const read = await tenant.owner.get(`/workflow/workflows/${ids.workflowId}`).expect(200);
    expectDocumented(workflowResponseSchema, read.body);
    expect((read.body as { current_version: Version }).current_version).toEqual(body);

    const listed = await tenant.member.get('/workflow/workflows').expect(200);
    const data = (listed.body as { data: unknown[] }).data;
    data.forEach((row) => expectDocumented(workflowSummaryResponseSchema, row));
    expect(data).toEqual([expect.objectContaining({ key: 'cast_rings', version: 1 })]);
  });

  it('keeps earlier versions unchanged when the steps are edited', async () => {
    const tenant = await freshTenant();
    const ids = await setup(tenant);
    await tenant.owner.put(`/workflow/workflows/${ids.workflowId}/steps`, castSteps(ids)).expect(200);

    const lustre = { key: 'lustre', label: 'Lustre', required: true, kind: 'yes_no', passing_answer: true };
    const second = await tenant.owner
      .put(`/workflow/workflows/${ids.workflowId}/steps`, castSteps(ids, [surface, lustre]))
      .expect(200);
    expect((second.body as Version).number).toBe(2);
    expect((second.body as Version).steps[3].checklist.map((item) => item.key)).toEqual(['surface', 'lustre']);

    const first = await tenant.owner.get(`/workflow/workflows/${ids.workflowId}/versions/1`).expect(200);
    expectDocumented(workflowVersionResponseSchema, first.body);
    expect((first.body as Version).steps[3].checklist.map((item) => item.key)).toEqual(['surface']);
    await tenant.owner.get(`/workflow/workflows/${ids.workflowId}/versions/3`).expect(404);

    const current = (await tenant.owner.get(`/workflow/workflows/${ids.workflowId}`).expect(200)).body as {
      current_version: Version;
    };
    expect(current.current_version.number).toBe(2);

    const entries = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'workflow.changed', subjectType: 'workflow' } }),
    );
    // Created, then two versions.
    expect(entries).toHaveLength(3);
  });

  it('refuses steps that point at nothing, or at the wrong place', async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const ids = await setup(tenant);
    const otherIds = await setup(other);
    const path = `/workflow/workflows/${ids.workflowId}/steps`;
    const steps = castSteps(ids).steps;
    const withStep = (index: number, change: object) => ({
      steps: steps.map((step, at) => (at === index ? { ...step, ...change } : step)),
    });

    // A rework target after the step itself.
    await tenant.owner.put(path, withStep(3, { rework_targets: ['final_qc'] })).expect(400);

    await tenant.owner.patch(`/workflow/defects/${ids.defects.crack}`, { active: false }).expect(200);
    await tenant.owner.put(path, castSteps(ids)).expect(404);
    await tenant.owner.patch(`/workflow/defects/${ids.defects.crack}`, { active: true }).expect(200);

    for (const body of [
      withStep(0, { step_type_id: newId() }),
      withStep(0, { step_type_id: otherIds.types.printPattern }),
      withStep(2, { defects: [{ defect_id: otherIds.defects.crack, outcome: 'scrap' }] }),
      withStep(2, { sop_file_version_id: newId() }),
    ]) {
      const response = await tenant.owner.put(path, body);
      expect(response.status).toBe(404);
    }
    await tenant.owner.put(`/workflow/workflows/${otherIds.workflowId}/steps`, castSteps(ids)).expect(404);
    expect((await tenant.owner.get(`/workflow/workflows/${ids.workflowId}`).expect(200)).body).toMatchObject({
      current_version: null,
    });

    await tenant.owner.post('/workflow/workflows', { key: 'cast_rings', name: 'Again' }).expect(409);
    await tenant.owner.post('/workflow/workflows', { key: 'Cast Rings', name: 'Bad key' }).expect(400);
  });

  it('says which steps a partner does, and at which step the partner is owed', async () => {
    const tenant = await freshTenant();
    const ids = await setup(tenant);
    const path = `/workflow/workflows/${ids.workflowId}/steps`;
    const doneBy = (version: unknown) =>
      (version as { steps: { key: string; done_by: string }[] }).steps.map((step) => [step.key, step.done_by]);

    // Without `done_by`, as every workflow made before partners: every step is the partner's,
    // and the partner is owed at the last one.
    const plain = await tenant.owner.put(path, castSteps(ids)).expect(200);
    expectDocumented(workflowVersionResponseSchema, plain.body);
    expect(doneBy(plain.body).every(([, by]) => by === 'partner')).toBe(true);
    expect(plain.body).toMatchObject({ payout_step: 'packing' });

    // Packing done in-house: the partner is owed at final QC.
    const steps = castSteps(ids).steps;
    const inHouse = { steps: steps.map((step) => (step.key === 'packing' ? { ...step, done_by: 'workspace' } : step)) };
    const second = await tenant.owner.put(path, inHouse).expect(200);
    expectDocumented(workflowVersionResponseSchema, second.body);
    expect(doneBy(second.body).at(-1)).toEqual(['packing', 'workspace']);
    expect(second.body).toMatchObject({ number: 2, payout_step: 'final_qc' });

    // A payout step the workflow names is kept, also on the version read back.
    const third = await tenant.owner.put(path, { ...inHouse, payout_step: 'polishing' }).expect(200);
    expect(third.body).toMatchObject({ number: 3, payout_step: 'polishing' });
    const read = await tenant.owner.get(`/workflow/workflows/${ids.workflowId}/versions/3`).expect(200);
    expectDocumented(workflowVersionResponseSchema, read.body);
    expect(read.body).toMatchObject({ payout_step: 'polishing' });
    expect((await tenant.owner.get(`/workflow/workflows/${ids.workflowId}/versions/1`).expect(200)).body).toMatchObject({
      payout_step: 'packing',
    });

    // Never a step the workspace does, nor one the workflow doesn't have.
    await tenant.owner.put(path, { ...inHouse, payout_step: 'packing' }).expect(400);
    await tenant.owner.put(path, { ...inHouse, payout_step: 'engraving' }).expect(400);

    // Sent again without `done_by`, packing stays in-house; and a payout step there is still refused.
    const resent = await tenant.owner.put(path, castSteps(ids)).expect(200);
    expect(doneBy(resent.body).at(-1)).toEqual(['packing', 'workspace']);
    expect(doneBy(resent.body).slice(0, -1).every(([, by]) => by === 'partner')).toBe(true);
    expect(resent.body).toMatchObject({ payout_step: 'final_qc' });
    const refused = await tenant.owner.put(path, { ...castSteps(ids), payout_step: 'packing' }).expect(400);
    expect((refused.body as { errors: { path: string }[] }).errors[0].path).toBe('payout_step');
  });

  it("assigns a workflow to a category, and lets a product use its own", async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const ids = await setup(tenant);
    const otherIds = await setup(other);
    const special = id(await tenant.owner.post('/workflow/workflows', { key: 'special', name: 'Special rings' }).expect(201));
    const productPath = `/workflow/products/${ids.productId}/workflow`;

    const none = await tenant.owner.get(productPath).expect(200);
    expectDocumented(productWorkflowResponseSchema, none.body);
    expect(none.body).toEqual({ product_id: ids.productId, workflow: null, own: false });

    await tenant.owner.put(`/workflow/categories/${ids.categoryId}/workflow`, { workflow_id: ids.workflowId }).expect(200);
    expect((await tenant.owner.get(productPath).expect(200)).body).toMatchObject({
      workflow: { id: ids.workflowId, key: 'cast_rings' },
      own: false,
    });

    const own = await tenant.owner.put(productPath, { workflow_id: special }).expect(200);
    expectDocumented(productWorkflowResponseSchema, own.body);
    expect(own.body).toMatchObject({ workflow: { id: special, key: 'special' }, own: true });

    await tenant.owner.delete(productPath).expect(204);
    expect((await tenant.owner.get(productPath).expect(200)).body).toMatchObject({ workflow: { id: ids.workflowId }, own: false });

    await tenant.owner.put(productPath, { workflow_id: otherIds.workflowId }).expect(404);
    await tenant.owner.put(`/workflow/products/${otherIds.productId}/workflow`, { workflow_id: special }).expect(404);
    await tenant.owner.put(`/workflow/categories/${otherIds.categoryId}/workflow`, { workflow_id: special }).expect(404);
  });

  it('keeps workflow setup to staff who may change it', async () => {
    const tenant = await freshTenant();
    const ids = await setup(tenant);

    await tenant.member.get(`/workflow/workflows/${ids.workflowId}`).expect(200);
    await tenant.member.post('/workflow/workflows', { key: 'other', name: 'Other' }).expect(403);
    await tenant.member.put(`/workflow/workflows/${ids.workflowId}/steps`, castSteps(ids)).expect(403);
    await tenant.member.put(`/workflow/categories/${ids.categoryId}/workflow`, { workflow_id: ids.workflowId }).expect(403);
    await tenant.customer.get('/workflow/workflows').expect(403);
  });
});
