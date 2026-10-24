import { z } from 'zod';
import { OUTCOMES, checklistItemSchema } from './workflow-config';

// What clients receive for workflow configuration; checked against real responses in the e2e tests.

export const defectResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  /** An inactive defect stays on past transitions but can't be added to a workflow step. */
  active: z.boolean(),
});
export type DefectResponse = z.infer<typeof defectResponseSchema>;

const evidenceResponseSchema = z.strictObject({ min_photos: z.number().int(), comment_required: z.boolean() });

export const workflowStepResponseSchema = z.strictObject({
  id: z.uuid(),
  /** From 0, in the order pieces go through the steps. */
  position: z.number().int(),
  key: z.string(),
  name: z.string(),
  /** `priced` is as it was when this version was made: it decides the paths of pieces on this version. */
  step_type: z.strictObject({ id: z.uuid(), key: z.string(), name: z.string(), priced: z.boolean() }),
  checklist: z.array(checklistItemSchema),
  defects: z.array(
    z.strictObject({
      defect_id: z.uuid(),
      key: z.string(),
      name: z.string(),
      outcome: z.enum(OUTCOMES),
      rework_to: z.string().nullable(),
    }),
  ),
  rework_targets: z.array(z.string()),
  pass: evidenceResponseSchema,
  fail: evidenceResponseSchema,
  sop_file_version_id: z.uuid().nullable(),
  expected_minutes: z.string().nullable(),
  customer: z.union([
    z.strictObject({ visible: z.literal(false) }),
    z.strictObject({ visible: z.literal(true), name: z.string() }),
  ]),
});
export type WorkflowStepResponse = z.infer<typeof workflowStepResponseSchema>;

export const workflowVersionResponseSchema = z.strictObject({
  workflow_id: z.uuid(),
  number: z.number().int(),
  created_at: z.iso.datetime(),
  steps: z.array(workflowStepResponseSchema),
});
export type WorkflowVersionResponse = z.infer<typeof workflowVersionResponseSchema>;

export const workflowSummaryResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  /** The current version's number; null until steps are first set. */
  version: z.number().int().nullable(),
});
export type WorkflowSummaryResponse = z.infer<typeof workflowSummaryResponseSchema>;

export const workflowResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  /** The latest version, which new work orders start on; null until steps are first set. */
  current_version: workflowVersionResponseSchema.nullable(),
});
export type WorkflowResponse = z.infer<typeof workflowResponseSchema>;

export const categoryWorkflowResponseSchema = z.strictObject({
  category_id: z.uuid(),
  workflow_id: z.uuid(),
});
export type CategoryWorkflowResponse = z.infer<typeof categoryWorkflowResponseSchema>;

export const productWorkflowResponseSchema = z.strictObject({
  product_id: z.uuid(),
  /** The product's own workflow, else its category's; null when neither has one. */
  workflow: z.strictObject({ id: z.uuid(), key: z.string(), name: z.string() }).nullable(),
  /** True when the product replaces its category's workflow. */
  own: z.boolean(),
});
export type ProductWorkflowResponse = z.infer<typeof productWorkflowResponseSchema>;
