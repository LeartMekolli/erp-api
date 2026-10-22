import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { stepPriceResponseSchema } from '../src/modules/pricing/pricing-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface StepPrice {
  id: string;
  material_id: string | null;
  failure_percent: string;
  blocks: { kind: string }[];
}

describe('pricing: step prices from building blocks', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const as = (token: string) => ({
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
      delete: (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`),
    });
    return {
      id: tenant.id,
      owner: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken),
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** The casting step, and silver (with density), resin (per ml) and brass (per g, no density). */
  async function setup(tenant: Tenant) {
    const id = (response: request.Response) => (response.body as { id: string }).id;
    const casting = id(
      await tenant.owner
        .post('/pricing/step-types', { key: 'casting', name: 'Casting', position: 30, summary_group: 'making' })
        .expect(201),
    );
    const material = async (body: object) => id(await tenant.owner.post('/catalog/materials', body).expect(201));
    return {
      casting,
      silver: await material({
        key: 'silver_925',
        name: 'Silver 925',
        priced_unit: 'g',
        density_g_cm3: '10.36',
        price_source: 'feed',
        feed_metal: 'silver',
        fallback_price: '0.85',
      }),
      resin: await material({ key: 'standard_resin', name: 'Standard resin', priced_unit: 'ml', price_source: 'manual', manual_price: '0.12' }),
      brass: await material({ key: 'brass', name: 'Brass', priced_unit: 'g', price_source: 'manual', manual_price: '0.012' }),
    };
  }

  const castingBlocks = [
    { kind: 'material', source: { configuration: true }, basis: 'weight', loss_percent: '5' },
    { kind: 'setup', amount: '15' },
    { kind: 'batch', size: 8, cost_per_batch: '40', material: { source: { configuration: true }, amount: '20', unit: 'g' } },
  ];

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

  it("keeps a step's default price and a material's own, replaces on a second save, and audits", async () => {
    const tenant = await freshTenant();
    const { casting, silver, resin } = await setup(tenant);

    const fallback = await tenant.owner
      .put(`/pricing/step-types/${casting}/prices`, { failure_percent: '3', blocks: castingBlocks })
      .expect(200);
    expectDocumented(stepPriceResponseSchema, fallback.body);
    expect(fallback.body).toMatchObject({ step_type_id: casting, material_id: null, failure_percent: '3', blocks: castingBlocks });

    const forSilver = await tenant.owner
      .put(`/pricing/step-types/${casting}/prices`, {
        material_id: silver,
        failure_percent: '2',
        blocks: [
          ...castingBlocks,
          // The pattern's resin, whatever the configuration's metal.
          { kind: 'material', source: { material_id: resin }, basis: 'volume', loss_percent: '0' },
          { kind: 'labour', base_minutes: '5', per: { measure: 'surface_area', unit: 'cm2', minutes: '1' }, hourly_rate: '30' },
        ],
      })
      .expect(200);
    expectDocumented(stepPriceResponseSchema, forSilver.body);
    expect(forSilver.body).toMatchObject({ material_id: silver, failure_percent: '2' });

    // Same step and material: replaced, not added.
    const replaced = await tenant.owner
      .put(`/pricing/step-types/${casting}/prices`, { material_id: silver, failure_percent: '4', blocks: [{ kind: 'fixed', amount: '9' }] })
      .expect(200);
    expect(replaced.body).toMatchObject({ id: (forSilver.body as StepPrice).id, failure_percent: '4', blocks: [{ kind: 'fixed' }] });

    const listed = await tenant.owner.get(`/pricing/step-types/${casting}/prices`).expect(200);
    const prices = (listed.body as { data: StepPrice[] }).data;
    prices.forEach((price) => expectDocumented(stepPriceResponseSchema, price));
    // The step's default first.
    expect(prices.map((price) => [price.material_id, price.failure_percent])).toEqual([
      [null, '3'],
      [silver, '4'],
    ]);

    const entries = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'pricing.changed', subjectType: 'step_price' }, orderBy: { id: 'asc' } }),
    );
    expect(entries).toHaveLength(3);
    expect(entries[2]).toMatchObject({ before: { failure_percent: '2' }, after: { failure_percent: '4' } });

    await tenant.owner.delete(`/pricing/step-prices/${(replaced.body as StepPrice).id}`).expect(204);
    const after = (await tenant.owner.get(`/pricing/step-types/${casting}/prices`).expect(200)).body as { data: StepPrice[] };
    expect(after.data.map((price) => price.material_id)).toEqual([null]);
    await tenant.owner.delete(`/pricing/step-prices/${(replaced.body as StepPrice).id}`).expect(404);
  });

  it('refuses blocks that cannot be priced', async () => {
    const tenant = await freshTenant();
    const { casting, resin, brass } = await setup(tenant);

    for (const body of [
      { failure_percent: '0', blocks: [] },
      { failure_percent: '101', blocks: [{ kind: 'fixed', amount: '1' }] },
      { failure_percent: '0', blocks: [{ kind: 'formula', expression: 'volume * 2' }] },
      { failure_percent: '0', blocks: [{ kind: 'fixed', amount: '1e2' }] },
      { failure_percent: '0', blocks: [{ kind: 'fixed', amount: 'abc' }] },
      { failure_percent: '0', blocks: [{ kind: 'setup', amount: '1' }, { kind: 'setup', amount: '2' }] },
      { failure_percent: '0', blocks: [{ kind: 'batch', size: 0, cost_per_batch: '1' }] },
      { failure_percent: '0', blocks: [{ kind: 'material', source: { configuration: true }, basis: 'weight', loss_percent: '101' }] },
      // A unit of the wrong dimension for its measure, and one that does not exist.
      { failure_percent: '0', blocks: [{ kind: 'per_measure', measure: 'surface_area', unit: 'g', rate: '1' }] },
      { failure_percent: '0', blocks: [{ kind: 'per_measure', measure: 'surface_area', unit: 'furlong2', rate: '1' }] },
      { failure_percent: '0', blocks: [{ kind: 'per_measure', measure: 'resolution', unit: 'piece', rate: '1' }] },
      // Resin is priced per ml: it cannot be charged by weight or per piece.
      { failure_percent: '0', blocks: [{ kind: 'material', source: { material_id: resin }, basis: 'weight', loss_percent: '0' }] },
      { failure_percent: '0', blocks: [{ kind: 'material', source: { material_id: resin }, basis: 'piece', loss_percent: '0' }] },
      // Brass has no density, so its weight cannot come from a volume.
      { failure_percent: '0', blocks: [{ kind: 'material', source: { material_id: brass }, basis: 'weight', loss_percent: '0' }] },
      {
        failure_percent: '0',
        blocks: [{ kind: 'batch', size: 8, cost_per_batch: '40', material: { source: { material_id: brass }, amount: '2', unit: 'cm3' } }],
      },
    ]) {
      const response = await tenant.owner.put(`/pricing/step-types/${casting}/prices`, body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
  });

  it('keeps step prices to staff who may see them, and to the workspace', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const idsA = await setup(a);
    const idsB = await setup(b);
    const fixed = { failure_percent: '0', blocks: [{ kind: 'fixed', amount: '1' }] };

    await a.member.get(`/pricing/step-types/${idsA.casting}/prices`).expect(403);
    await a.member.put(`/pricing/step-types/${idsA.casting}/prices`, fixed).expect(403);

    await a.owner.put(`/pricing/step-types/${idsB.casting}/prices`, fixed).expect(404);
    await a.owner.put(`/pricing/step-types/${newId()}/prices`, fixed).expect(404);
    await a.owner.get(`/pricing/step-types/${idsB.casting}/prices`).expect(404);
    await a.owner.put(`/pricing/step-types/${idsA.casting}/prices`, { ...fixed, material_id: idsB.silver }).expect(404);
    await a.owner
      .put(`/pricing/step-types/${idsA.casting}/prices`, {
        failure_percent: '0',
        blocks: [{ kind: 'material', source: { material_id: idsB.resin }, basis: 'volume', loss_percent: '0' }],
      })
      .expect(404);

    const own = (await b.owner.put(`/pricing/step-types/${idsB.casting}/prices`, fixed).expect(200)).body as StepPrice;
    await a.owner.delete(`/pricing/step-prices/${own.id}`).expect(404);
  });
});
