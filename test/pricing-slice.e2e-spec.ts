import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { quoteResponseSchema, quoteResultResponseSchema, quoteSummaryResponseSchema } from '../src/modules/pricing/quote-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { castWorkflow } from './workflow-fixtures';

interface Staff {
  unit_price: string;
  total: string;
  expired: boolean;
  breakdown: {
    steps: { key: string; cost: string; blocks: { kind: string; quantity?: string; unit?: string; rate?: string; amount: string }[] }[];
    adjustments: { kind: string; percent: string; amount: string }[];
    unit_price: string;
    total: string;
  };
}
interface Summary {
  id: string;
  unit_price: string;
  lines: { label: string; amount: string }[];
}

/**
 * The Pricing spec's "Done when", steps 1–8, through the API as the owner, as in Swagger. Only the
 * design file is written straight to the database, already measured (a 10 mm cube).
 */
describe('pricing: the done-when walkthrough', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

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

  it('prices the cast part from step costs to a held quote and its customer summary', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const http = () => request(app.getHttpServer());
    const post = (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body);
    const put = (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body);
    const get = (path: string) => http().get(path).set('Authorization', `Bearer ${token}`);
    const id = (response: request.Response) => (response.body as { id: string }).id;

    // The Catalog's walkthrough: silver and brass, material and finish, "gold plated requires silver", the cast part.
    const silver = id(
      await post('/catalog/materials', {
        key: 'silver_925',
        name: 'Silver 925',
        priced_unit: 'g',
        density_g_cm3: '10.36',
        price_source: 'feed',
        feed_metal: runMetal,
        fallback_price: '0.85',
      }).expect(201),
    );
    const brass = id(
      await post('/catalog/materials', { key: 'brass', name: 'Brass', priced_unit: 'g', density_g_cm3: '8.5', price_source: 'manual', manual_price: '0.012' }).expect(201),
    );
    const resin = id(
      await post('/catalog/materials', { key: 'pattern_resin', name: 'Pattern resin', priced_unit: 'ml', price_source: 'manual', manual_price: '0.12' }).expect(201),
    );
    const materialGroup = id(await post('/catalog/option-groups', { key: 'material', name: 'Material' }).expect(201));
    const finish = id(await post('/catalog/option-groups', { key: 'finish', name: 'Finish' }).expect(201));
    const value = async (groupId: string, key: string, materialId?: string) =>
      id(await post(`/catalog/option-groups/${groupId}/values`, { key, name: key, material_id: materialId }).expect(201));
    const v = {
      silver: await value(materialGroup, 'silver_925', silver),
      brass: await value(materialGroup, 'brass', brass),
      raw: await value(finish, 'raw'),
      polished: await value(finish, 'polished'),
      gold: await value(finish, 'gold_plated'),
    };
    await post('/catalog/option-rules', { kind: 'requires', value_id: v.gold, target_value_ids: [v.silver] }).expect(201);
    const categoryId = id(
      await post('/catalog/categories', { key: 'cast_metal', name: 'Cast metal parts', required_measures: ['volume'] }).expect(201),
    );
    const productId = id(
      await post('/catalog/products', {
        category_id: categoryId,
        key: 'custom_cast_part',
        name: 'Custom cast part',
        kind: 'custom',
        sizing: { mode: 'range', min: '0.5', max: '2' },
      }).expect(201),
    );
    await put(`/catalog/products/${productId}/options`, {
      groups: [
        { group_id: materialGroup, required: true, value_ids: [v.silver, v.brass] },
        { group_id: finish, required: true, default_value_id: v.raw, value_ids: [v.raw, v.polished, v.gold] },
      ],
    }).expect(200);
    const design = await measuredDesign(prisma, tenant.id, owner.id);

    // 1. Step types and their prices.
    const stepType = async (key: string, position: number, summary_group: string) =>
      id(await post('/pricing/step-types', { key, name: key, position, summary_group }).expect(201));
    const printPattern = await stepType('print_pattern', 10, 'making');
    const castingTree = await stepType('casting_tree', 20, 'making');
    const casting = await stepType('casting', 30, 'making');
    const polishing = await stepType('polishing', 40, 'finishing');
    const plating = await stepType('plating', 50, 'finishing');
    const price = (stepId: string, blocks: object[]) =>
      put(`/pricing/step-types/${stepId}/prices`, { failure_percent: '0', blocks }).expect(200);
    await price(printPattern, [
      { kind: 'material', source: { material_id: resin }, basis: 'volume', loss_percent: '0' },
      { kind: 'machine_time', base_minutes: '30', hourly_rate: '6' },
    ]);
    await price(castingTree, [
      { kind: 'batch', size: 8, cost_per_batch: '40', material: { source: { configuration: true }, amount: '20', unit: 'g' } },
    ]);
    await price(casting, [
      { kind: 'material', source: { configuration: true }, basis: 'weight', loss_percent: '5' },
      { kind: 'setup', amount: '15' },
    ]);
    await price(polishing, [
      { kind: 'labour', base_minutes: '5', per: { measure: 'surface_area', unit: 'cm2', minutes: '1' }, hourly_rate: '30' },
    ]);
    await price(plating, [{ kind: 'per_measure', measure: 'surface_area', unit: 'cm2', rate: '0.4' }]);
    await put('/pricing/profile', { margin_percent: '40', overhead_per_piece: '2', quote_valid_hours: 168 }).expect(200);
    await put('/pricing/discount-tiers', { tiers: [{ min_quantity: 10, percent: '5' }] }).expect(200);
    await post('/pricing/delivery-speeds', { key: 'standard', name: 'Standard', surcharge_percent: '0', is_default: true }).expect(201);
    await post('/pricing/delivery-speeds', { key: 'rush', name: 'Rush', surcharge_percent: '30' }).expect(201);

    // 2. The category's chain, and gold plating adds plating.
    await put(`/pricing/categories/${categoryId}/steps`, { step_type_ids: [printPattern, castingTree, casting, polishing] }).expect(200);
    await put(`/pricing/option-values/${v.gold}/step-effects`, { add: [plating], remove: [] }).expect(200);
    // Quoting needs a workflow with every step the quote prices (Workflow/QC spec F13).
    await castWorkflow({ post, put }, { steps: { printPattern, castingTree, casting, polishing, plating }, categoryId });

    const quote = async (extra: object = {}) => {
      const response = await post('/pricing/quotes', {
        product_id: productId,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        file_version_id: design.versionId,
        quantity: 1,
        ...extra,
      }).expect(201);
      expectDocumented(quoteResultResponseSchema, response.body);
      const saved = (response.body as { quote: Summary }).quote;
      const staff = await get(`/pricing/quotes/${saved.id}`).expect(200);
      expectDocumented(quoteResponseSchema, staff.body);
      return { id: saved.id, staff: staff.body as Staff };
    };

    // 3. One piece in silver, polished, at 1.5×: the grams of silver and their price, each step, the total.
    const one = await quote();
    expect(one.staff.breakdown.steps.map((step) => [step.key, step.cost])).toEqual([
      ['print_pattern', '3.405'],
      ['casting_tree', '57'],
      ['casting', '46.2062625'],
      ['polishing', '9.25'],
    ]);
    const silverLine = one.staff.breakdown.steps[2].blocks[0];
    expect(silverLine).toEqual({ kind: 'material', quantity: '34.965', unit: 'g', rate: '0.85', amount: '31.2062625' });
    expect(one.staff).toMatchObject({ unit_price: '165.01', total: '165.01' });

    // 4. Twenty pieces: less per piece, from the shared tree and setup and the 10+ tier.
    const twenty = await quote({ quantity: 20 });
    expect(Number(twenty.staff.unit_price)).toBeLessThan(Number(one.staff.unit_price));
    expect(twenty.staff.breakdown.steps.find((step) => step.key === 'casting_tree')?.cost).toBe('8.55');
    expect(twenty.staff.breakdown.adjustments.map((line) => line.kind)).toContain('quantity_discount');

    // 5. Gold plating: the plating step appears and the price rises.
    const plated = await quote({ options: { material: 'silver_925', finish: 'gold_plated' } });
    expect(plated.staff.breakdown.steps.map((step) => step.key)).toContain('plating');
    expect(Number(plated.staff.unit_price)).toBeGreaterThan(Number(one.staff.unit_price));

    // 6. Rush: the surcharge appears.
    const rush = await quote({ delivery_speed: 'rush' });
    expect(rush.staff.breakdown.adjustments).toContainEqual(expect.objectContaining({ kind: 'delivery_speed', percent: '30' }));
    expect(Number(rush.staff.unit_price)).toBeGreaterThan(Number(one.staff.unit_price));

    // 7. The silver price changes: the saved quote keeps its price until it expires.
    await put(`/catalog/materials/${silver}/price-override`, { price: '0.95', reason: 'supplier' }).expect(200);
    expect((await get(`/pricing/quotes/${one.id}`).expect(200)).body).toEqual(one.staff);
    expect(Number((await quote()).staff.unit_price)).toBeGreaterThan(Number(one.staff.unit_price));
    await prisma.inTenant(tenant.id, (tx) => tx.quote.update({ where: { id: one.id }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    expect((await get(`/pricing/quotes/${one.id}`).expect(200)).body).toMatchObject({ expired: true, unit_price: '165.01', total: '165.01' });

    // 8. The customer summary of the same quote: only grouped lines, adding up to the price.
    const summary = await get(`/pricing/quotes/${one.id}/summary`).expect(200);
    expectDocumented(quoteSummaryResponseSchema, summary.body);
    const lines = (summary.body as Summary).lines;
    expect(lines.map((line) => line.label)).toEqual(['material', 'making', 'finishing']);
    expect(lines.reduce((cents, line) => cents + Math.round(Number(line.amount) * 100), 0)).toBe(16501);
  });
});
