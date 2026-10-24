import type { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { workflowStepsSchema } from '../modules/workflow/workflow-config';
import type { StepConfig } from '../modules/workflow/workflow-config';

// Demo workflows for the demo catalog and pricing (`seed-catalog.ts`, `seed-pricing.ts`): the checked
// steps printed and cast parts go through, from making to packing. Every step type a demo chain or
// option effect can price has a step, so every demo product can be quoted.

const DEFECTS = [
  { key: 'porosity', name: 'Porosity' },
  { key: 'scratch', name: 'Scratch' },
  { key: 'crack', name: 'Crack' },
];

/** Steps nobody prices: they run in every workflow that has them. */
const NOT_PRICED = [
  { key: 'final_qc', name: 'Final QC', position: 90 },
  { key: 'packing', name: 'Packing', position: 95 },
];

const surface = {
  key: 'surface',
  label: 'Surface',
  required: true,
  kind: 'choice',
  options: [
    { key: 'ok', label: 'Smooth', passing: true },
    { key: 'pitted', label: 'Pitted', passing: false },
  ],
};

const finalQc = {
  key: 'final_qc',
  name: 'Final QC',
  checklist: [
    { key: 'dimensions', label: 'Dimensions match the order', required: true, kind: 'yes_no', passing_answer: true },
    { key: 'notes', label: 'Notes', required: false, kind: 'text' },
  ],
  defects: [{ defect: 'scratch', outcome: 'rework', rework_to: 'polishing' }],
  pass: { min_photos: 1, comment_required: false },
  customer: { visible: true, name: 'Quality check' },
};

/** Category key → workflow, its steps by step type key, with defects by key. */
const WORKFLOWS: Record<string, { key: string; name: string; steps: Record<string, unknown>[] }> = {
  cast_metal: {
    key: 'cast_metal',
    name: 'Cast metal parts',
    steps: [
      { key: 'print_pattern', name: 'Print pattern' },
      { key: 'casting_tree', name: 'Casting tree' },
      {
        key: 'casting',
        name: 'Casting',
        defects: [
          { defect: 'porosity', outcome: 'rework', rework_to: 'casting' },
          { defect: 'crack', outcome: 'scrap' },
        ],
        rework_targets: ['casting'],
        expected_minutes: '45',
        customer: { visible: true, name: 'Casting' },
      },
      {
        key: 'polishing',
        name: 'Polishing',
        checklist: [surface],
        defects: [
          { defect: 'scratch', outcome: 'rework', rework_to: 'polishing' },
          { defect: 'porosity', outcome: 'rework', rework_to: 'casting' },
        ],
        rework_targets: ['casting', 'polishing'],
        fail: { min_photos: 1, comment_required: true },
        expected_minutes: '20',
        customer: { visible: true, name: 'Finishing' },
      },
      { key: 'plating', name: 'Plating', customer: { visible: true, name: 'Finishing' } },
      { ...finalQc, rework_targets: ['polishing'] },
      { key: 'packing', name: 'Packing' },
    ],
  },
  printed_parts: {
    key: 'printed_parts',
    name: 'Printed parts',
    steps: [
      { key: 'print', name: 'Print', customer: { visible: true, name: 'Printing' } },
      { key: 'cure', name: 'Cure' },
      {
        key: 'finish',
        name: 'Finish',
        checklist: [surface],
        defects: [{ defect: 'scratch', outcome: 'rework', rework_to: 'finish' }],
        rework_targets: ['finish'],
        customer: { visible: true, name: 'Finishing' },
      },
      { ...finalQc, defects: [{ defect: 'scratch', outcome: 'rework', rework_to: 'finish' }], rework_targets: ['finish'] },
      { key: 'packing', name: 'Packing' },
    ],
  },
};

export interface WorkflowSeedCounts {
  defects: number;
  stepTypes: number;
  workflows: number;
}

/**
 * Seeds the demo workflows into one workspace that already has the demo catalog and pricing, each
 * assigned to its category. Idempotent: defects, step types and workflows that exist (by key) are left
 * as they are, and a category that has a workflow keeps it.
 */
export async function seedWorkflows(prisma: PrismaService, tenantId: string): Promise<WorkflowSeedCounts> {
  const created: WorkflowSeedCounts = { defects: 0, stepTypes: 0, workflows: 0 };

  await prisma.inTenant(tenantId, async (tx) => {
    const defectIds = new Map<string, string>();
    for (const defect of DEFECTS) {
      const existing = await tx.defect.findFirst({ where: { key: defect.key } });
      const row = existing ?? (await tx.defect.create({ data: defect }));
      if (!existing) created.defects++;
      defectIds.set(defect.key, row.id);
    }

    for (const step of NOT_PRICED) {
      if (await tx.stepType.findFirst({ where: { key: step.key } })) continue;
      await tx.stepType.create({ data: { key: step.key, name: step.name, position: step.position, summaryGroup: null } });
      created.stepTypes++;
    }
    const stepTypes = await tx.stepType.findMany({ select: { id: true, key: true, summaryGroup: true } });
    const stepTypeIds = new Map(stepTypes.map((row) => [row.key, row.id]));
    const priced = new Set(stepTypes.filter((row) => row.summaryGroup !== null).map((row) => row.id));

    for (const [categoryKey, workflow] of Object.entries(WORKFLOWS)) {
      const category = await tx.category.findFirst({ where: { key: categoryKey } });
      if (!category || (await tx.workflow.findFirst({ where: { key: workflow.key } }))) continue;

      // Keys become ids, then the steps are checked as the API would.
      const { steps } = workflowStepsSchema.parse({
        steps: workflow.steps.map((step) => ({
          ...step,
          step_type_id: stepTypeIds.get(step.key as string),
          defects: ((step.defects ?? []) as { defect: string }[]).map(({ defect, ...rest }) => ({
            ...rest,
            defect_id: defectIds.get(defect),
          })),
        })),
      });
      const row = await tx.workflow.create({ data: { key: workflow.key, name: workflow.name } });
      const version = await tx.workflowVersion.create({ data: { workflowId: row.id, number: 1, createdByUserId: null } });
      await tx.workflowStep.createMany({
        data: steps.map((step, position) => {
          const config: StepConfig = {
            checklist: step.checklist,
            defects: step.defects,
            rework_targets: step.rework_targets,
            pass: step.pass,
            fail: step.fail,
            customer: step.customer,
          };
          return {
            versionId: version.id,
            position,
            key: step.key,
            name: step.name,
            stepTypeId: step.step_type_id,
            priced: priced.has(step.step_type_id),
            config: config as Prisma.InputJsonValue,
            expectedMinutes: step.expected_minutes,
          };
        }),
      });
      if (!category.workflowId) {
        await tx.category.update({ where: { id: category.id }, data: { workflowId: row.id } });
      }
      created.workflows++;
    }
  });

  return created;
}
