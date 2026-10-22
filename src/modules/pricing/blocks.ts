import { z } from 'zod';
import type { Dimension } from '../catalog/units';
import { MEASURE_TYPES } from '../files/measurers';
import type { MeasureType } from '../files/measurers';
import { amountSchema, percentSchema } from './decimals';

// The fixed building blocks a step's cost is made of (Pricing spec, R11): staff fill them with
// numbers, never with formulas. Every amount is per piece unless the block says otherwise.

/** The dimension of each measure's value; `resolution` has none a price can use. */
export const MEASURE_DIMENSION: Record<MeasureType, Dimension | null> = {
  width: 'length',
  height: 'length',
  bounding_box_x: 'length',
  bounding_box_y: 'length',
  bounding_box_z: 'length',
  surface_area: 'area',
  volume: 'volume',
  page_count: 'count',
  resolution: null,
};

/** The configuration's material (from the Catalog check), or a material named on the step. */
const materialSourceSchema = z.union([
  z.strictObject({ configuration: z.literal(true) }),
  z.strictObject({ material_id: z.uuid() }),
]);

/** A catalog unit key, seeded or the workspace's; checked against the units on save. */
const unitKeySchema = z.string().min(1).max(32);

/** Minutes for each `unit` of the measure, such as 1 minute per cm² of surface. */
const perMeasureMinutesSchema = z.strictObject({ measure: z.enum(MEASURE_TYPES), unit: unitKeySchema, minutes: amountSchema });

const timeFields = {
  base_minutes: amountSchema,
  per: perMeasureMinutesSchema.optional(),
  hourly_rate: amountSchema,
};

export const MATERIAL_BASES = ['weight', 'volume', 'piece'] as const;
export type MaterialBasis = (typeof MATERIAL_BASES)[number];

export const blockSchema = z.discriminatedUnion('kind', [
  /** The design's weight (volume × density), its volume, or one piece, × the material's price, plus loss. */
  z.strictObject({
    kind: z.literal('material'),
    source: materialSourceSchema,
    basis: z.enum(MATERIAL_BASES),
    loss_percent: percentSchema(0, 100),
  }),
  z.strictObject({ kind: z.literal('machine_time'), ...timeFields }),
  z.strictObject({ kind: z.literal('labour'), ...timeFields }),
  /** `rate` per one `unit` of the measure, such as plating per cm². */
  z.strictObject({ kind: z.literal('per_measure'), measure: z.enum(MEASURE_TYPES), unit: unitKeySchema, rate: amountSchema }),
  z.strictObject({ kind: z.literal('fixed'), amount: amountSchema }),
  /** Per production run, shared by the quantity. */
  z.strictObject({ kind: z.literal('setup'), amount: amountSchema }),
  /** `size` pieces share one batch (a casting tree, a print bed); its cost and lost material are shared by the pieces. */
  z.strictObject({
    kind: z.literal('batch'),
    size: z.number().int().min(1).max(10_000),
    cost_per_batch: amountSchema,
    /** Material lost per batch, such as the metal in a tree that is not recovered; a mass or volume unit. */
    material: z.strictObject({ source: materialSourceSchema, amount: amountSchema, unit: unitKeySchema }).optional(),
  }),
]);
export type Block = z.infer<typeof blockSchema>;
export type MaterialSource = z.infer<typeof materialSourceSchema>;

export const blocksSchema = z
  .array(blockSchema)
  .min(1)
  .max(10)
  .refine((blocks) => blocks.filter((block) => block.kind === 'setup').length <= 1, 'at most one setup block')
  .refine((blocks) => blocks.filter((block) => block.kind === 'batch').length <= 1, 'at most one batch block');
