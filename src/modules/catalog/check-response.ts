import { z } from 'zod';
import { MEASURE_TYPES } from '../files/measurers';
import { currentPriceSchema } from './material-response';

// What clients receive from the configuration check; checked against real
// responses in the e2e tests. A refusal is a normal answer, not an error (B2, B8).

export const REFUSAL_CODES = [
  'unknown_group',
  'unknown_value',
  'value_not_offered',
  'required_missing',
  'rule_excludes',
  'rule_requires',
  'size_out_of_range',
  'unknown_size',
  'not_sizeable',
  'file_required',
  'file_not_measured',
  'measure_missing',
  'no_material',
  'conflicting_materials',
  'price_missing',
] as const;

export const checkResponseSchema = z.discriminatedUnion('accepted', [
  z.strictObject({
    accepted: z.literal(true),
    /** Every answered group's value key by group key, defaults included. */
    options: z.record(z.string(), z.string()),
    scale: z.string(),
    /** The design's measures at `scale`, in catalog units. */
    measures: z.array(z.strictObject({ type: z.enum(MEASURE_TYPES), value: z.string(), unit: z.string() })),
    material: z.strictObject({ id: z.uuid(), key: z.string(), name: z.string(), price: currentPriceSchema }),
  }),
  z.strictObject({
    accepted: z.literal(false),
    reasons: z.array(
      z.strictObject({
        code: z.enum(REFUSAL_CODES),
        message: z.string(),
        /** The option rule that refused, for `rule_excludes` and `rule_requires`. */
        rule_id: z.uuid().optional(),
      }),
    ),
  }),
]);
export type CheckResponse = z.infer<typeof checkResponseSchema>;
