import type request from 'supertest';
import type { PrismaService } from '../src/database/prisma.service';
import { measuredDesign } from './catalog-fixtures';
import { castWorkflow } from './workflow-fixtures';

/** A staff client of the workspace being set up, with catalog and pricing write access. */
export interface StaffClient {
  post(path: string, body: object): request.Test;
  put(path: string, body: object): request.Test;
}

/**
 * The walkthrough's cast part, priced: silver (fallback 0.85/g) or brass, finish raw/polished/gold plated
 * ("gold plated requires silver"), the cast-metal chain print pattern → casting tree → casting → polishing,
 * gold plated adds plating and raw removes polishing; margin 40 %, overhead 2, tier 10+ 5 %, speeds
 * standard (default, 0 %) and rush (30 %), the trade group (−10 %), and the category's workflow
 * (`castWorkflow`). The design is the 10 mm cube.
 *
 * `runMetal` is a feed metal of the test run's own: feed snapshots are platform-wide and outlive test
 * runs, and a metal with none leaves silver at its fallback.
 */
export async function pricedCastPart(
  staff: StaffClient,
  prisma: PrismaService,
  tenant: { id: string; staffUserId: string; runMetal: string },
) {
  const id = (response: request.Response) => (response.body as { id: string }).id;
  const material = async (body: object) => id(await staff.post('/catalog/materials', body).expect(201));
  const silver = await material({
    key: 'silver_925',
    name: 'Silver 925',
    priced_unit: 'g',
    density_g_cm3: '10.36',
    price_source: 'feed',
    feed_metal: tenant.runMetal,
    fallback_price: '0.85',
  });
  const brass = await material({ key: 'brass', name: 'Brass', priced_unit: 'g', density_g_cm3: '8.5', price_source: 'manual', manual_price: '0.012' });
  const resin = await material({ key: 'pattern_resin', name: 'Pattern resin', priced_unit: 'ml', price_source: 'manual', manual_price: '0.12' });

  const group = async (key: string) => id(await staff.post('/catalog/option-groups', { key, name: key }).expect(201));
  const value = async (groupId: string, key: string, materialId?: string) =>
    id(await staff.post(`/catalog/option-groups/${groupId}/values`, { key, name: key, material_id: materialId }).expect(201));
  const materialGroup = await group('material');
  const finish = await group('finish');
  const v = {
    silver: await value(materialGroup, 'silver_925', silver),
    brass: await value(materialGroup, 'brass', brass),
    raw: await value(finish, 'raw'),
    polished: await value(finish, 'polished'),
    gold: await value(finish, 'gold_plated'),
  };
  await staff.post('/catalog/option-rules', { kind: 'requires', value_id: v.gold, target_value_ids: [v.silver] }).expect(201);

  const categoryId = id(
    await staff.post('/catalog/categories', { key: 'cast_metal', name: 'Cast metal parts', required_measures: ['volume'] }).expect(201),
  );
  const productId = id(
    await staff
      .post('/catalog/products', {
        category_id: categoryId,
        key: 'custom_cast_part',
        name: 'Custom cast part',
        kind: 'custom',
        sizing: { mode: 'range', min: '0.5', max: '2' },
      })
      .expect(201),
  );
  await staff
    .put(`/catalog/products/${productId}/options`, {
      groups: [
        { group_id: materialGroup, required: true, value_ids: [v.silver, v.brass] },
        { group_id: finish, required: true, default_value_id: v.raw, value_ids: [v.raw, v.polished, v.gold] },
      ],
    })
    .expect(200);

  const stepType = async (key: string, position: number, summary_group: string) =>
    id(await staff.post('/pricing/step-types', { key, name: key, position, summary_group }).expect(201));
  const steps = {
    printPattern: await stepType('print_pattern', 10, 'making'),
    castingTree: await stepType('casting_tree', 20, 'making'),
    casting: await stepType('casting', 30, 'making'),
    polishing: await stepType('polishing', 40, 'finishing'),
    plating: await stepType('plating', 50, 'finishing'),
  };
  await staff
    .put(`/pricing/categories/${categoryId}/steps`, {
      step_type_ids: [steps.printPattern, steps.castingTree, steps.casting, steps.polishing],
    })
    .expect(200);
  await staff.put(`/pricing/option-values/${v.gold}/step-effects`, { add: [steps.plating], remove: [] }).expect(200);
  await staff.put(`/pricing/option-values/${v.raw}/step-effects`, { add: [], remove: [steps.polishing] }).expect(200);

  const price = (stepId: string, blocks: object[]) =>
    staff.put(`/pricing/step-types/${stepId}/prices`, { failure_percent: '0', blocks }).expect(200);
  await price(steps.printPattern, [
    { kind: 'material', source: { material_id: resin }, basis: 'volume', loss_percent: '0' },
    { kind: 'machine_time', base_minutes: '30', hourly_rate: '6' },
  ]);
  await price(steps.castingTree, [
    { kind: 'batch', size: 8, cost_per_batch: '40', material: { source: { configuration: true }, amount: '20', unit: 'g' } },
  ]);
  await price(steps.casting, [
    { kind: 'material', source: { configuration: true }, basis: 'weight', loss_percent: '5' },
    { kind: 'setup', amount: '15' },
  ]);
  await price(steps.polishing, [
    { kind: 'labour', base_minutes: '5', per: { measure: 'surface_area', unit: 'cm2', minutes: '1' }, hourly_rate: '30' },
  ]);
  await price(steps.plating, [{ kind: 'per_measure', measure: 'surface_area', unit: 'cm2', rate: '0.4' }]);

  await staff.put('/pricing/profile', { margin_percent: '40', overhead_per_piece: '2', quote_valid_hours: 168 }).expect(200);
  await staff.put('/pricing/discount-tiers', { tiers: [{ min_quantity: 10, percent: '5' }] }).expect(200);
  await staff.post('/pricing/delivery-speeds', { key: 'standard', name: 'Standard', surcharge_percent: '0', is_default: true }).expect(201);
  await staff.post('/pricing/delivery-speeds', { key: 'rush', name: 'Rush', surcharge_percent: '30' }).expect(201);
  const tradeGroupId = id(await staff.post('/pricing/customer-groups', { key: 'trade', name: 'Trade', percent: '-10' }).expect(201));

  // Every product being quoted needs a workflow with each step it prices (Workflow/QC spec F13).
  const workflow = await castWorkflow(staff, { steps, categoryId });

  const design = await measuredDesign(prisma, tenant.id, tenant.staffUserId);
  return { silver, brass, resin, v, steps, categoryId, productId, tradeGroupId, versionId: design.versionId, workflow };
}
export type PricedCastPart = Awaited<ReturnType<typeof pricedCastPart>>;
