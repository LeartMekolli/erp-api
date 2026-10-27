import { z } from 'zod';
import { MEASURE_TYPES } from '../files/measurers';
import { scaleSchema, sizingSchema } from './scaling';

// What clients receive for categories and products; checked against real
// responses in the e2e tests.

export const categoryResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  /** Measures a ready-made product's design file must have. */
  required_measures: z.array(z.enum(MEASURE_TYPES)),
});
export type CategoryResponse = z.infer<typeof categoryResponseSchema>;

export const productOptionsSchema = z.strictObject({
  group_id: z.uuid(),
  required: z.boolean(),
  default_value_id: z.uuid().nullable(),
  value_ids: z.array(z.uuid()),
});

export const PRODUCT_KINDS = ['custom', 'ready_made', 'assembly'] as const;

/** The size a part is made at: a scale, a named size, or null for the part as it is. */
export const partSizeSchema = z.union([z.strictObject({ scale: scaleSchema }), z.strictObject({ named: z.string().min(1).max(32) })]);

export const productResponseSchema = z.strictObject({
  id: z.uuid(),
  category_id: z.uuid(),
  key: z.string(),
  name: z.string(),
  /** An assembly is made of ready-made parts, and has no design file or sizing of its own. */
  kind: z.enum(PRODUCT_KINDS),
  status: z.string(),
  /** A material the product fixes; otherwise the chosen options select one. */
  material_id: z.uuid().nullable(),
  sizing: sizingSchema,
  /** The pinned, measured design file of a ready-made product. */
  design_file: z.strictObject({ file_id: z.uuid(), version_id: z.uuid() }).nullable(),
  /** The option groups offered, in order. */
  options: z.array(productOptionsSchema),
  /** Whether customers see it (shared products) or its customer sees it (private ones). */
  published: z.boolean(),
  /** The customer a private product belongs to; null for the shared catalog. */
  customer_id: z.uuid().nullable(),
  /** An assembly's parts, in order, each with how many go into one assembly; empty for every other kind. */
  parts: z.array(
    z.strictObject({
      product: z.strictObject({ id: z.uuid(), name: z.string() }),
      quantity: z.number().int(),
      size: partSizeSchema.nullable(),
    }),
  ),
});
export type ProductResponse = z.infer<typeof productResponseSchema>;
