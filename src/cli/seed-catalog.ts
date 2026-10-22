import type { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';

// A demo catalog for made-to-order 3D objects: printed parts and cast metal parts.
// Names and prices are made up; prices are in the workspace's currency.

const REQUIRED_MEASURES = ['volume', 'bounding_box_x', 'bounding_box_y', 'bounding_box_z'];

const CATEGORIES = [
  { key: 'printed_parts', name: 'Printed parts' },
  { key: 'cast_metal', name: 'Cast metal parts' },
];

const MATERIALS = [
  { key: 'resin_standard', name: 'Standard resin', density: '1.12', manual: '0.15' },
  { key: 'nylon_pa12', name: 'Nylon PA12', density: '1.01', manual: '0.09' },
  { key: 'pla', name: 'PLA', density: '1.24', manual: '0.03' },
  { key: 'silver_925', name: 'Silver 925', density: '10.36', feed: { metal: 'silver', percent: '8', fallback: '0.85' } },
  { key: 'gold_18k', name: 'Gold 18k', density: '15.6', feed: { metal: 'gold', percent: '12', fallback: '48' } },
  { key: 'brass', name: 'Brass', density: '8.5', manual: '0.012' },
];

const GROUPS = [
  { key: 'material', name: 'Material', values: MATERIALS.map((material) => ({ key: material.key, name: material.name })) },
  {
    key: 'finish',
    name: 'Finish',
    values: [
      { key: 'raw', name: 'Raw' },
      { key: 'polished', name: 'Polished' },
      { key: 'gold_plated', name: 'Gold plated' },
    ],
  },
];

const RULES = [
  { kind: 'requires', value: 'gold_plated', targets: ['silver_925'] },
  { kind: 'excludes', value: 'nylon_pa12', targets: ['polished'] },
];

const PRODUCTS = [
  {
    key: 'custom_resin_print',
    name: 'Custom resin print',
    category: 'printed_parts',
    kind: 'custom',
    sizing: { mode: 'range', min: '0.25', max: '4' },
    materials: ['resin_standard', 'nylon_pa12', 'pla'],
    finishes: ['raw', 'polished'],
  },
  {
    key: 'custom_cast_part',
    name: 'Custom cast part',
    category: 'cast_metal',
    kind: 'custom',
    sizing: { mode: 'range', min: '0.5', max: '2' },
    materials: ['silver_925', 'gold_18k', 'brass'],
    finishes: ['raw', 'polished', 'gold_plated'],
  },
  {
    key: 'ring_model_12',
    name: 'Ring model 12',
    category: 'cast_metal',
    kind: 'ready_made',
    sizing: {
      mode: 'named',
      sizes: [
        { key: 'S', scale: '0.9' },
        { key: 'M', scale: '1' },
        { key: 'L', scale: '1.1' },
      ],
    },
    materials: ['silver_925', 'gold_18k'],
    finishes: ['raw', 'polished', 'gold_plated'],
  },
];

export interface CatalogSeedCounts {
  categories: number;
  materials: number;
  optionGroups: number;
  optionValues: number;
  optionRules: number;
  products: number;
}

/**
 * Seeds the demo catalog into one workspace. Idempotent: anything whose key already exists is
 * left as it is. `ringVersionId`, a measured design version, becomes Ring model 12's own file.
 */
export async function seedCatalog(
  prisma: PrismaService,
  tenantId: string,
  options: { ringVersionId?: string } = {},
): Promise<CatalogSeedCounts> {
  const created: CatalogSeedCounts = {
    categories: 0,
    materials: 0,
    optionGroups: 0,
    optionValues: 0,
    optionRules: 0,
    products: 0,
  };

  await prisma.inTenant(tenantId, async (tx) => {
    const { defaultCurrency } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });

    const categoryIds = new Map<string, string>();
    for (const category of CATEGORIES) {
      const existing = await tx.category.findFirst({ where: { key: category.key } });
      const row = existing ?? (await tx.category.create({ data: { ...category, requiredMeasures: REQUIRED_MEASURES } }));
      if (!existing) created.categories++;
      categoryIds.set(category.key, row.id);
    }

    const materialIds = new Map<string, string>();
    for (const material of MATERIALS) {
      const existing = await tx.material.findFirst({ where: { key: material.key } });
      const row =
        existing ??
        (await tx.material.create({
          data: {
            key: material.key,
            name: material.name,
            pricedUnit: 'g',
            densityGCm3: material.density,
            currency: defaultCurrency,
            ...(material.feed
              ? {
                  priceSource: 'feed',
                  feedMetal: material.feed.metal,
                  addonPercent: material.feed.percent,
                  fallbackPrice: material.feed.fallback,
                }
              : { priceSource: 'manual', manualPrice: material.manual }),
          },
        }));
      if (!existing) created.materials++;
      materialIds.set(material.key, row.id);
    }

    const valueIds = new Map<string, string>();
    const groupIds = new Map<string, string>();
    for (const group of GROUPS) {
      const existing = await tx.optionGroup.findFirst({ where: { key: group.key } });
      const row = existing ?? (await tx.optionGroup.create({ data: { key: group.key, name: group.name } }));
      if (!existing) created.optionGroups++;
      groupIds.set(group.key, row.id);
      for (const value of group.values) {
        const found = await tx.optionValue.findFirst({ where: { groupId: row.id, key: value.key } });
        const valueRow =
          found ??
          (await tx.optionValue.create({
            data: { groupId: row.id, key: value.key, name: value.name, materialId: materialIds.get(value.key) ?? null },
          }));
        if (!found) created.optionValues++;
        valueIds.set(value.key, valueRow.id);
      }
    }

    const valueId = (key: string) => valueIds.get(key) ?? '';
    for (const rule of RULES) {
      const existing = await tx.optionRule.findFirst({
        where: { kind: rule.kind, valueId: valueId(rule.value), targets: { some: { valueId: valueId(rule.targets[0]) } } },
      });
      if (existing) continue;
      await tx.optionRule.create({
        data: {
          kind: rule.kind,
          valueId: valueId(rule.value),
          targets: { create: rule.targets.map((target) => ({ valueId: valueId(target) })) },
        },
      });
      created.optionRules++;
    }

    for (const product of PRODUCTS) {
      if (await tx.product.findFirst({ where: { key: product.key } })) continue;
      const row = await tx.product.create({
        data: {
          categoryId: categoryIds.get(product.category) ?? '',
          key: product.key,
          name: product.name,
          kind: product.kind,
          sizing: product.sizing as Prisma.InputJsonValue,
          fileVersionId: product.kind === 'ready_made' ? (options.ringVersionId ?? null) : null,
        },
      });
      created.products++;

      await tx.productOptionGroup.createMany({
        data: [
          { productId: row.id, groupId: groupIds.get('material') ?? '', required: true, position: 0 },
          {
            productId: row.id,
            groupId: groupIds.get('finish') ?? '',
            required: true,
            defaultValueId: valueId('raw'),
            position: 1,
          },
        ],
      });
      await tx.productOptionValue.createMany({
        data: [...product.materials, ...product.finishes].map((key) => ({ productId: row.id, valueId: valueId(key) })),
      });
    }
  });

  return created;
}
