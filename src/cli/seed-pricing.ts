import type { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { blocksSchema } from '../modules/pricing/blocks';
import type { SummaryGroup } from '../modules/pricing/pricing-response';

// Demo pricing for the demo catalog (`seed-catalog.ts`): the steps printed and cast parts go
// through, what each costs, and the workspace's adjustments. Numbers are made up; amounts are in
// the workspace's currency.

const STEP_TYPES: { key: string; name: string; position: number; group: SummaryGroup }[] = [
  { key: 'print_pattern', name: 'Print pattern', position: 10, group: 'making' },
  { key: 'casting_tree', name: 'Casting tree', position: 20, group: 'making' },
  { key: 'casting', name: 'Casting', position: 30, group: 'making' },
  { key: 'polishing', name: 'Polishing', position: 40, group: 'finishing' },
  { key: 'plating', name: 'Plating', position: 50, group: 'finishing' },
  { key: 'engraving', name: 'Engraving', position: 60, group: 'finishing' },
  { key: 'print', name: 'Print', position: 10, group: 'making' },
  { key: 'cure', name: 'Cure', position: 20, group: 'making' },
  { key: 'finish', name: 'Finish', position: 40, group: 'finishing' },
];

const CHAINS: Record<string, string[]> = {
  cast_metal: ['print_pattern', 'casting_tree', 'casting', 'polishing'],
  printed_parts: ['print', 'cure', 'finish'],
};

/** Option value key → steps it adds or removes. */
const EFFECTS: { value: string; step: string; effect: 'add' | 'remove' }[] = [
  { value: 'gold_plated', step: 'plating', effect: 'add' },
  { value: 'raw', step: 'polishing', effect: 'remove' },
];

const configuration = { configuration: true } as const;

/** Step key, the material the price is for (null: the step's default), failure %, blocks. */
const PRICES: { step: string; material: string | null; failure: string; blocks: Record<string, unknown>[] }[] = [
  {
    step: 'print_pattern',
    material: null,
    failure: '2',
    blocks: [
      { kind: 'material', source: { material_key: 'resin_standard' }, basis: 'weight', loss_percent: '10' },
      { kind: 'machine_time', base_minutes: '30', hourly_rate: '6' },
    ],
  },
  {
    step: 'casting_tree',
    material: null,
    failure: '0',
    blocks: [{ kind: 'batch', size: 8, cost_per_batch: '40', material: { source: configuration, amount: '20', unit: 'g' } }],
  },
  {
    step: 'casting',
    material: null,
    failure: '3',
    blocks: [
      { kind: 'material', source: configuration, basis: 'weight', loss_percent: '5' },
      { kind: 'setup', amount: '15' },
    ],
  },
  // Gold is cast with less loss and more care.
  {
    step: 'casting',
    material: 'gold_18k',
    failure: '2',
    blocks: [
      { kind: 'material', source: configuration, basis: 'weight', loss_percent: '2' },
      { kind: 'setup', amount: '25' },
    ],
  },
  {
    step: 'polishing',
    material: null,
    failure: '0',
    blocks: [{ kind: 'labour', base_minutes: '5', per: { measure: 'surface_area', unit: 'cm2', minutes: '1' }, hourly_rate: '30' }],
  },
  {
    step: 'plating',
    material: null,
    failure: '1',
    blocks: [{ kind: 'per_measure', measure: 'surface_area', unit: 'cm2', rate: '0.4' }],
  },
  { step: 'engraving', material: null, failure: '0', blocks: [{ kind: 'fixed', amount: '8' }] },
  {
    step: 'print',
    material: null,
    failure: '3',
    blocks: [
      { kind: 'material', source: configuration, basis: 'weight', loss_percent: '3' },
      { kind: 'machine_time', base_minutes: '10', per: { measure: 'volume', unit: 'cm3', minutes: '2' }, hourly_rate: '6' },
    ],
  },
  { step: 'cure', material: null, failure: '0', blocks: [{ kind: 'machine_time', base_minutes: '15', hourly_rate: '4' }] },
  {
    step: 'finish',
    material: null,
    failure: '0',
    blocks: [{ kind: 'labour', base_minutes: '5', per: { measure: 'surface_area', unit: 'cm2', minutes: '0.5' }, hourly_rate: '25' }],
  },
];

const PROFILE = { marginPercent: '40', overheadPerPiece: '2', quoteValidHours: 4 };
const TIERS = [
  { minQuantity: 10, percent: '5' },
  { minQuantity: 50, percent: '10' },
];
const GROUPS = [
  { key: 'retail', name: 'Retail', percent: '0' },
  { key: 'trade', name: 'Trade', percent: '-10' },
];
const SPEEDS = [
  { key: 'standard', name: 'Standard', surchargePercent: '0', workingDays: 10, isDefault: true },
  { key: 'express', name: 'Express', surchargePercent: '15', workingDays: 5, isDefault: false },
  { key: 'rush', name: 'Rush', surchargePercent: '30', workingDays: 2, isDefault: false },
];

export interface PricingSeedCounts {
  stepTypes: number;
  stepPrices: number;
  chains: number;
  tiers: number;
  groups: number;
  speeds: number;
}

/**
 * Seeds the demo pricing into one workspace that already has the demo catalog. Idempotent: anything
 * that already exists (by key, by step and material, a category that has a chain) is left as it is.
 */
export async function seedPricing(prisma: PrismaService, tenantId: string): Promise<PricingSeedCounts> {
  const created: PricingSeedCounts = { stepTypes: 0, stepPrices: 0, chains: 0, tiers: 0, groups: 0, speeds: 0 };

  await prisma.inTenant(tenantId, async (tx) => {
    const stepIds = new Map<string, string>();
    for (const step of STEP_TYPES) {
      const existing = await tx.stepType.findFirst({ where: { key: step.key } });
      const row =
        existing ??
        (await tx.stepType.create({
          data: { key: step.key, name: step.name, position: step.position, summaryGroup: step.group },
        }));
      if (!existing) created.stepTypes++;
      stepIds.set(step.key, row.id);
    }

    const materialId = async (key: string) => (await tx.material.findFirstOrThrow({ where: { key } })).id;
    for (const price of PRICES) {
      const stepTypeId = stepIds.get(price.step)!;
      const forMaterial = price.material ? await materialId(price.material) : null;
      if (await tx.stepPrice.findFirst({ where: { stepTypeId, materialId: forMaterial } })) continue;
      // Material keys become ids, then the blocks are checked as the API would.
      const blocks = blocksSchema.parse(
        await Promise.all(
          price.blocks.map(async (block) => {
            const source = block.source as { material_key?: string } | undefined;
            return source?.material_key ? { ...block, source: { material_id: await materialId(source.material_key) } } : block;
          }),
        ),
      );
      await tx.stepPrice.create({
        data: { stepTypeId, materialId: forMaterial, failurePercent: price.failure, blocks: blocks as Prisma.InputJsonValue },
      });
      created.stepPrices++;
    }

    for (const [categoryKey, steps] of Object.entries(CHAINS)) {
      const category = await tx.category.findFirst({ where: { key: categoryKey }, include: { steps: true } });
      if (!category || category.steps.length > 0) continue;
      await tx.categoryStep.createMany({
        data: steps.map((key) => ({ categoryId: category.id, stepTypeId: stepIds.get(key)! })),
      });
      created.chains++;
    }

    for (const effect of EFFECTS) {
      const value = await tx.optionValue.findFirst({ where: { key: effect.value, group: { key: 'finish' } } });
      if (!value) continue;
      const stepTypeId = stepIds.get(effect.step)!;
      if (await tx.optionStepEffect.findFirst({ where: { valueId: value.id, stepTypeId } })) continue;
      await tx.optionStepEffect.create({ data: { valueId: value.id, stepTypeId, effect: effect.effect } });
    }

    if (!(await tx.pricingProfile.findFirst())) {
      await tx.pricingProfile.create({ data: PROFILE });
    }

    for (const tier of TIERS) {
      if (await tx.discountTier.findFirst({ where: { minQuantity: tier.minQuantity } })) continue;
      await tx.discountTier.create({ data: tier });
      created.tiers++;
    }

    for (const group of GROUPS) {
      if (await tx.customerGroup.findFirst({ where: { key: group.key } })) continue;
      await tx.customerGroup.create({ data: group });
      created.groups++;
    }

    const hasDefault = Boolean(await tx.deliverySpeed.findFirst({ where: { isDefault: true } }));
    for (const speed of SPEEDS) {
      if (await tx.deliverySpeed.findFirst({ where: { key: speed.key } })) continue;
      await tx.deliverySpeed.create({ data: { ...speed, isDefault: speed.isDefault && !hasDefault } });
      created.speeds++;
    }
  });

  return created;
}
