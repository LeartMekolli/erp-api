import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import type { MeasureType } from '../files/measurers';

const PLAIN_SCALE = /^\d{1,3}(\.\d{1,4})?$/;

/** A scale factor written plainly: 0.01 to 100, at most 4 decimals, no sign or exponent (C3). */
export const scaleSchema = z
  .string()
  .regex(PLAIN_SCALE, 'must be a decimal from 0.01 to 100 with at most 4 places, such as 1.5')
  // Zod runs refinements after a failed regex too, so only parse what the regex accepted.
  .refine((value) => {
    if (!PLAIN_SCALE.test(value)) return true;
    const scale = new Prisma.Decimal(value);
    return scale.greaterThan(0) && scale.lessThanOrEqualTo(100);
  }, 'must be greater than 0 and at most 100');

/** Throws a `ZodError` (a 400) for anything `scaleSchema` refuses. */
export function parseScale(value: string): Prisma.Decimal {
  return new Prisma.Decimal(scaleSchema.parse(value));
}

const sizeKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, 'letters, digits, _ and -, such as S or XL');

/** How a product can be sized: not at all, within a range, or by named sizes (C3). */
export const sizingSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z
    .strictObject({ mode: z.literal('range'), min: scaleSchema, max: scaleSchema })
    .refine(
      (range) =>
        !PLAIN_SCALE.test(range.min) ||
        !PLAIN_SCALE.test(range.max) ||
        new Prisma.Decimal(range.min).lessThan(range.max),
      { path: ['max'], message: 'must be greater than min' },
    ),
  z.strictObject({
    mode: z.literal('named'),
    sizes: z
      .array(z.strictObject({ key: sizeKeySchema, scale: scaleSchema }))
      .min(1)
      .max(20)
      .refine((sizes) => new Set(sizes.map((size) => size.key)).size === sizes.length, 'size keys must not repeat'),
  }),
]);
export type Sizing = z.infer<typeof sizingSchema>;

export interface ScalableMeasure {
  type: MeasureType;
  value: Prisma.Decimal;
  unit: string;
}

/** The power of the scale each measure grows by; anything not geometric stays as it is. */
const SCALE_POWER: Record<MeasureType, number> = {
  width: 1,
  height: 1,
  bounding_box_x: 1,
  bounding_box_y: 1,
  bounding_box_z: 1,
  surface_area: 2,
  volume: 3,
  resolution: 0,
  page_count: 0,
};

/** Measures of the design at `scale`, computed rather than re-measured, rounded to 6 places. */
export function scaleMeasures<T extends ScalableMeasure>(measures: T[], scale: Prisma.Decimal): T[] {
  return measures.map((measure) => ({
    ...measure,
    value: measure.value.times(scale.pow(SCALE_POWER[measure.type])).toDecimalPlaces(6),
  }));
}
