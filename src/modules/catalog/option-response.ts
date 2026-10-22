import { z } from 'zod';

// What clients receive for option groups, values and rules; checked against
// real responses in the e2e tests.

export const optionValueResponseSchema = z.strictObject({
  id: z.uuid(),
  group_id: z.uuid(),
  key: z.string(),
  name: z.string(),
  /** The material choosing this value selects, if any. */
  material_id: z.uuid().nullable(),
});
export type OptionValueResponse = z.infer<typeof optionValueResponseSchema>;

export const optionGroupResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  values: z.array(optionValueResponseSchema),
});
export type OptionGroupResponse = z.infer<typeof optionGroupResponseSchema>;

export const optionRuleResponseSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['excludes', 'requires']),
  value_id: z.uuid(),
  target_value_ids: z.array(z.uuid()),
});
export type OptionRuleResponse = z.infer<typeof optionRuleResponseSchema>;
