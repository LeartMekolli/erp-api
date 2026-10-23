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
