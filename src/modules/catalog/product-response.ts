import { z } from 'zod';
import { MEASURE_TYPES } from '../files/measurers';
import { sizingSchema } from './scaling';

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

export const productResponseSchema = z.strictObject({
  id: z.uuid(),
  category_id: z.uuid(),
  key: z.string(),
  name: z.string(),
  kind: z.enum(['custom', 'ready_made']),
  status: z.string(),
  /** A material the product fixes; otherwise the chosen options select one. */
  material_id: z.uuid().nullable(),
  sizing: sizingSchema,
  /** The pinned, measured design file of a ready-made product. */
  design_file: z.strictObject({ file_id: z.uuid(), version_id: z.uuid() }).nullable(),
  /** The option groups offered, in order. */
  options: z.array(productOptionsSchema),
});
export type ProductResponse = z.infer<typeof productResponseSchema>;
