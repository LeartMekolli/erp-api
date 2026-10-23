import type { Prisma, StepType, WorkflowStep } from '../../generated/prisma/client';

// Which workflow a product goes through. Plain functions over a transaction, so Pricing can use
// them without depending on the workflow module (as Catalog's visibility rule is shared).

export type WorkflowStepRow = WorkflowStep & { stepType: StepType };

export interface ResolvedWorkflow {
  workflowId: string;
  name: string;
  versionId: string;
  versionNumber: number;
  /** In position order. */
  steps: WorkflowStepRow[];
}

/**
 * The chain's step types the workflow has no step of, in chain order (F13): a product can't be quoted,
 * and so can't be ordered, while priced work could be skipped in production.
 */
export function missingStepTypes(steps: { stepTypeId: string }[], chainStepTypeIds: string[]): string[] {
  const covered = new Set(steps.map((step) => step.stepTypeId));
  return chainStepTypeIds.filter((id) => !covered.has(id));
}

/**
 * The product's own workflow, else its category's, at its latest version. A workflow without a
 * version yet counts as none; so does an unknown product.
 */
export async function resolveWorkflow(tx: Prisma.TransactionClient, productId: string): Promise<ResolvedWorkflow | null> {
  const product = await tx.product.findUnique({
    where: { id: productId },
    select: { workflowId: true, category: { select: { workflowId: true } } },
  });
  const workflowId = product?.workflowId ?? product?.category.workflowId;
  if (!workflowId) {
    return null;
  }
  const version = await tx.workflowVersion.findFirst({
    where: { workflowId },
    orderBy: { number: 'desc' },
    include: {
      workflow: { select: { name: true } },
      steps: { include: { stepType: true }, orderBy: { position: 'asc' } },
    },
  });
  if (!version) {
    return null;
  }
  return {
    workflowId,
    name: version.workflow.name,
    versionId: version.id,
    versionNumber: version.number,
    steps: version.steps,
  };
}
