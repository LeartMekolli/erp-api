import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import {
  categoryChainResponseSchema,
  productChainResponseSchema,
  stepEffectsResponseSchema,
} from '../src/modules/pricing/pricing-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Chain {
  own_chain?: boolean;
  steps: { key: string }[];
}

describe('pricing: step chains and option step effects', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const as = {
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
      delete: (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`),
    };
    return { id: tenant.id, owner: as };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** Four step types, a category, a product in it, and a finish group with two values. */
  async function setup(tenant: Tenant) {
    const id = (response: request.Response) => (response.body as { id: string }).id;
    const stepType = async (key: string, position: number) =>
      id(await tenant.owner.post('/pricing/step-types', { key, name: key, position, summary_group: 'making' }).expect(201));
    const steps = {
      printPattern: await stepType('print_pattern', 10),
      casting: await stepType('casting', 30),
      polishing: await stepType('polishing', 40),
      plating: await stepType('plating', 50),
    };
    const categoryId = id(
      await tenant.owner.post('/catalog/categories', { key: 'cast_metal', name: 'Cast metal parts' }).expect(201),
    );
    const productId = id(
      await tenant.owner
        .post('/catalog/products', { category_id: categoryId, key: 'ring', name: 'Ring', kind: 'custom' })
        .expect(201),
    );
    const groupId = id(await tenant.owner.post('/catalog/option-groups', { key: 'finish', name: 'Finish' }).expect(201));
    const value = async (key: string) =>
      id(await tenant.owner.post(`/catalog/option-groups/${groupId}/values`, { key, name: key }).expect(201));
    return { steps, categoryId, productId, gold: await value('gold_plated'), raw: await value('raw') };
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

  it("sets a category's chain and reads it back in position order", async () => {
    const tenant = await freshTenant();
    const { steps, categoryId } = await setup(tenant);

    const set = await tenant.owner
      .put(`/pricing/categories/${categoryId}/steps`, { step_type_ids: [steps.polishing, steps.printPattern, steps.casting] })
      .expect(200);
    expectDocumented(categoryChainResponseSchema, set.body);
    expect((set.body as Chain).steps.map((step) => step.key)).toEqual(['print_pattern', 'casting', 'polishing']);

    const read = await tenant.owner.get(`/pricing/categories/${categoryId}/steps`).expect(200);
    expect(read.body).toEqual(set.body);
  });

  it("lets a product replace its category's chain, and go back to it", async () => {
    const tenant = await freshTenant();
    const { steps, categoryId, productId } = await setup(tenant);
    await tenant.owner
      .put(`/pricing/categories/${categoryId}/steps`, { step_type_ids: [steps.printPattern, steps.casting, steps.polishing] })
      .expect(200);

    const inherited = await tenant.owner.get(`/pricing/products/${productId}/steps`).expect(200);
    expectDocumented(productChainResponseSchema, inherited.body);
    expect(inherited.body).toMatchObject({ own_chain: false, steps: [{ key: 'print_pattern' }, { key: 'casting' }, { key: 'polishing' }] });

    const own = await tenant.owner.put(`/pricing/products/${productId}/steps`, { step_type_ids: [steps.casting] }).expect(200);
    expectDocumented(productChainResponseSchema, own.body);
    expect(own.body).toMatchObject({ own_chain: true, steps: [{ key: 'casting' }] });

    // An empty chain of its own is allowed: the product is not made in steps the workspace prices.
    const empty = await tenant.owner.put(`/pricing/products/${productId}/steps`, { step_type_ids: [] }).expect(200);
    expect(empty.body).toMatchObject({ own_chain: true, steps: [] });

    await tenant.owner.delete(`/pricing/products/${productId}/steps`).expect(204);
    expect((await tenant.owner.get(`/pricing/products/${productId}/steps`).expect(200)).body).toMatchObject({
      own_chain: false,
      steps: [{ key: 'print_pattern' }, { key: 'casting' }, { key: 'polishing' }],
    });
  });

  it('records which steps an option value adds or removes', async () => {
    const tenant = await freshTenant();
    const { steps, gold, raw } = await setup(tenant);

    const plated = await tenant.owner
      .put(`/pricing/option-values/${gold}/step-effects`, { add: [steps.plating], remove: [] })
      .expect(200);
    expectDocumented(stepEffectsResponseSchema, plated.body);
    expect(plated.body).toMatchObject({ value_id: gold, add: [{ key: 'plating' }], remove: [] });

    await tenant.owner.put(`/pricing/option-values/${raw}/step-effects`, { add: [], remove: [steps.polishing] }).expect(200);
    const read = await tenant.owner.get(`/pricing/option-values/${raw}/step-effects`).expect(200);
    expectDocumented(stepEffectsResponseSchema, read.body);
    expect(read.body).toMatchObject({ value_id: raw, add: [], remove: [{ key: 'polishing' }] });

    // Replacing with nothing clears them.
    const cleared = await tenant.owner.put(`/pricing/option-values/${gold}/step-effects`, { add: [], remove: [] }).expect(200);
    expect(cleared.body).toMatchObject({ add: [], remove: [] });
  });

  it('refuses malformed chains and effects', async () => {
    const tenant = await freshTenant();
    const { steps, categoryId, gold } = await setup(tenant);

    for (const [path, body] of [
      [`/pricing/categories/${categoryId}/steps`, { step_type_ids: [steps.casting, steps.casting] }],
      [`/pricing/categories/${categoryId}/steps`, { step_type_ids: ['not-a-uuid'] }],
      [`/pricing/option-values/${gold}/step-effects`, { add: [steps.plating], remove: [steps.plating] }],
      [`/pricing/option-values/${gold}/step-effects`, { add: [steps.plating, steps.plating], remove: [] }],
    ] as const) {
      const response = await tenant.owner.put(path, body);
      expect({ path, body, status: response.status }).toEqual({ path, body, status: 400 });
    }
    await tenant.owner.put(`/pricing/categories/${categoryId}/steps`, { step_type_ids: [newId()] }).expect(404);
  });

  it('keeps not-priced step types out of chains, effects and prices', async () => {
    const tenant = await freshTenant();
    const { steps, categoryId, productId, gold } = await setup(tenant);
    const finalQc = (
      (await tenant.owner
        .post('/pricing/step-types', { key: 'final_qc', name: 'Final QC', position: 90, summary_group: null })
        .expect(201)).body as { id: string }
    ).id;

    for (const [path, body] of [
      [`/pricing/categories/${categoryId}/steps`, { step_type_ids: [steps.casting, finalQc] }],
      [`/pricing/products/${productId}/steps`, { step_type_ids: [finalQc] }],
      [`/pricing/option-values/${gold}/step-effects`, { add: [finalQc], remove: [] }],
      [`/pricing/step-types/${finalQc}/prices`, { failure_percent: '0', blocks: [{ kind: 'fixed', amount: '1' }] }],
    ] as const) {
      const response = await tenant.owner.put(path, body);
      expect({ path, status: response.status }).toEqual({ path, status: 400 });
    }

    // A step type already in a chain, an effect or a price can't stop being priced.
    await tenant.owner.put(`/pricing/categories/${categoryId}/steps`, { step_type_ids: [steps.casting] }).expect(200);
    await tenant.owner.put(`/pricing/option-values/${gold}/step-effects`, { add: [steps.plating], remove: [] }).expect(200);
    await tenant.owner
      .put(`/pricing/step-types/${steps.printPattern}/prices`, { failure_percent: '0', blocks: [{ kind: 'fixed', amount: '1' }] })
      .expect(200);
    for (const id of [steps.casting, steps.plating, steps.printPattern]) {
      const response = await tenant.owner.patch(`/pricing/step-types/${id}`, { summary_group: null });
      expect({ id, status: response.status }).toEqual({ id, status: 409 });
    }
    await tenant.owner.patch(`/pricing/step-types/${steps.polishing}`, { summary_group: null }).expect(200);
  });

  it("keeps every reference inside the workspace", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const idsA = await setup(a);
    const idsB = await setup(b);

    await a.owner.put(`/pricing/categories/${idsB.categoryId}/steps`, { step_type_ids: [idsA.steps.casting] }).expect(404);
    await a.owner.put(`/pricing/categories/${idsA.categoryId}/steps`, { step_type_ids: [idsB.steps.casting] }).expect(404);
    await a.owner.put(`/pricing/products/${idsB.productId}/steps`, { step_type_ids: [] }).expect(404);
    await a.owner.put(`/pricing/option-values/${idsB.gold}/step-effects`, { add: [], remove: [] }).expect(404);
    await a.owner.put(`/pricing/option-values/${idsA.gold}/step-effects`, { add: [idsB.steps.plating], remove: [] }).expect(404);
    await a.owner.get(`/pricing/products/${idsB.productId}/steps`).expect(404);
  });
});
