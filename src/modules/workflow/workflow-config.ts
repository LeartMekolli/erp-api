import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { amountSchema, keySchema } from '../pricing/decimals';

// What a workflow step is set up with (Workflow/QC spec, goal 3). Stored as the step's `config`,
// except the step type, SOP document and expected duration, which are columns.

const labelSchema = z.string().trim().min(1).max(200);

const optionSchema = z.strictObject({ key: keySchema, label: labelSchema, passing: z.boolean() });

const itemBase = { key: keySchema, label: labelSchema, required: z.boolean() };

export const checklistItemSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...itemBase,
      kind: z.literal('choice'),
      options: z
        .array(optionSchema)
        .min(2)
        .max(20)
        .refine((options) => new Set(options.map((option) => option.key)).size === options.length, 'option keys must not repeat'),
    }),
    /** `passing_answer` is the answer that passes the check. */
    z.strictObject({ ...itemBase, kind: z.literal('yes_no'), passing_answer: z.boolean() }),
    /** A measured value; within `min` and `max` (inclusive) when they are set. */
    z.strictObject({
      ...itemBase,
      kind: z.literal('number'),
      unit: z.string().trim().min(1).max(20).nullable().default(null),
      min: amountSchema.nullable().default(null),
      max: amountSchema.nullable().default(null),
    }),
    z.strictObject({ ...itemBase, kind: z.literal('text') }),
  ])
  .refine(
    (item) => item.kind !== 'number' || item.min === null || item.max === null || !new Prisma.Decimal(item.min).greaterThan(item.max),
    { path: ['min'], message: 'min must not be above max' },
  );
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

export const OUTCOMES = ['rework', 'scrap', 'continue'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** A defect allowed at a step, with what happens to a piece by default (D38). */
const stepDefectSchema = z
  .strictObject({ defect_id: z.uuid(), outcome: z.enum(OUTCOMES), rework_to: keySchema.optional() })
  .refine((defect) => (defect.outcome === 'rework') === (defect.rework_to !== undefined), {
    path: ['rework_to'],
    message: 'a rework names the step to go back to, and only a rework does',
  });

/** What a pass or a fail at the step must bring. */
const evidenceSchema = z
  .strictObject({ min_photos: z.number().int().min(0).max(20), comment_required: z.boolean() })
  .default({ min_photos: 0, comment_required: false });

/** Hidden from customers, or shown under a customer-facing name (D19). */
const customerSchema = z
  .discriminatedUnion('visible', [
    z.strictObject({ visible: z.literal(false) }),
    z.strictObject({ visible: z.literal(true), name: labelSchema }),
  ])
  .default({ visible: false });

export const workflowStepInputSchema = z.strictObject({
  key: keySchema,
  name: labelSchema,
  step_type_id: z.uuid(),
  checklist: z
    .array(checklistItemSchema)
    .max(50)
    .default([])
    .refine((items) => new Set(items.map((item) => item.key)).size === items.length, 'checklist keys must not repeat'),
  defects: z
    .array(stepDefectSchema)
    .max(50)
    .default([])
    .refine((defects) => new Set(defects.map((defect) => defect.defect_id)).size === defects.length, 'a defect must not repeat'),
  /** Steps a failed piece may be sent back to: this step or an earlier one. */
  rework_targets: z
    .array(keySchema)
    .max(100)
    .default([])
    .refine((keys) => new Set(keys).size === keys.length, 'a rework target must not repeat'),
  pass: evidenceSchema,
  fail: evidenceSchema,
  sop_file_version_id: z.uuid().nullable().default(null),
  /** Per piece, in minutes. Stored for delivery estimates and capacity later. */
  expected_minutes: amountSchema.nullable().default(null),
  customer: customerSchema,
});
export type WorkflowStepInput = z.infer<typeof workflowStepInputSchema>;

export const workflowStepsSchema = z
  .object({ steps: z.array(workflowStepInputSchema).min(1).max(100) })
  .superRefine(({ steps }, context) => {
    const seen = new Map<string, number>();
    steps.forEach((step, index) => {
      if (seen.has(step.key)) {
        context.addIssue({ code: 'custom', path: ['steps', index, 'key'], message: `${step.key} is already a step` });
      }
      seen.set(step.key, index);
    });
    steps.forEach((step, index) => {
      step.rework_targets.forEach((target, at) => {
        const position = seen.get(target);
        if (position === undefined || position > index) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'rework_targets', at],
            message: `${target} is not this step or an earlier one`,
          });
        }
      });
      step.defects.forEach((defect, at) => {
        if (defect.rework_to !== undefined && !step.rework_targets.includes(defect.rework_to)) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'defects', at, 'rework_to'],
            message: `${defect.rework_to} is not one of the step's rework targets`,
          });
        }
      });
    });
  });
export type WorkflowStepsInput = z.infer<typeof workflowStepsSchema>;

/** The `config` column of a workflow step. */
export type StepConfig = Pick<WorkflowStepInput, 'checklist' | 'defects' | 'rework_targets' | 'pass' | 'fail' | 'customer'>;
