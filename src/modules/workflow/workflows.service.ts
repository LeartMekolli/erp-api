import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma, Workflow, WorkflowVersion } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { conflictOnDuplicate, keySchema } from '../pricing/decimals';
import type { WorkflowStepRow } from './coverage';
import type { StepConfig, WorkflowStepsInput } from './workflow-config';
import type {
  CategoryWorkflowResponse,
  ProductWorkflowResponse,
  WorkflowResponse,
  WorkflowStepResponse,
  WorkflowSummaryResponse,
  WorkflowVersionResponse,
} from './workflow-response';

export const createWorkflowSchema = z.object({ key: keySchema, name: z.string().trim().min(1).max(200) });
export const assignWorkflowSchema = z.object({ workflow_id: z.uuid() });

type VersionRow = WorkflowVersion & { steps: WorkflowStepRow[] };

/** Workflows, their immutable versions, and which categories and products use them (D33, D34). */
@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(auth: TenantAuth, input: z.infer<typeof createWorkflowSchema>): Promise<WorkflowSummaryResponse> {
    try {
      return await this.prisma.inTenant(auth.tenantId, async (tx) => {
        const row = await tx.workflow.create({ data: { key: input.key, name: input.name } });
        const created = toSummary(row, null);
        await this.record(tx, auth, { type: 'workflow', id: row.id }, undefined, created);
        return created;
      });
    } catch (error) {
      conflictOnDuplicate(error, `A workflow with key ${input.key} already exists`);
    }
  }

  async list(tenantId: string): Promise<WorkflowSummaryResponse[]> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.workflow.findMany({
        orderBy: { key: 'asc' },
        include: { versions: { select: { number: true }, orderBy: { number: 'desc' }, take: 1 } },
      });
      return rows.map((row) => toSummary(row, row.versions[0]?.number ?? null));
    });
  }

  async get(tenantId: string, id: string): Promise<WorkflowResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const workflow = await this.find(tx, id);
      const latest = await tx.workflowVersion.findFirst({
        where: { workflowId: id },
        orderBy: { number: 'desc' },
        include: versionInclude,
      });
      return {
        id: workflow.id,
        key: workflow.key,
        name: workflow.name,
        current_version: latest ? await this.toVersion(tx, latest) : null,
      };
    });
  }

  async version(tenantId: string, id: string, number: number): Promise<WorkflowVersionResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      await this.find(tx, id);
      const version = await tx.workflowVersion.findFirst({ where: { workflowId: id, number }, include: versionInclude });
      if (!version) {
        throw new NotFoundException('Workflow version not found');
      }
      return this.toVersion(tx, version);
    });
  }

  /** Replaces the steps by adding the next version; pieces already started keep theirs (D34). */
  async setSteps(auth: TenantAuth, id: string, input: WorkflowStepsInput): Promise<WorkflowVersionResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      // Two edits at once would both pick the same next number; the second waits here instead.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM workflow WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) {
        throw new NotFoundException('Workflow not found');
      }
      await this.checkReferences(tx, input);

      const latest = await tx.workflowVersion.findFirst({ where: { workflowId: id }, orderBy: { number: 'desc' } });
      const version = await tx.workflowVersion.create({
        data: { workflowId: id, number: (latest?.number ?? 0) + 1, createdByUserId: auth.userId },
      });
      await tx.workflowStep.createMany({
        data: input.steps.map((step, position) => {
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
            config: config as Prisma.InputJsonValue,
            sopFileVersionId: step.sop_file_version_id,
            expectedMinutes: step.expected_minutes,
          };
        }),
      });

      const created = await this.toVersion(
        tx,
        await tx.workflowVersion.findUniqueOrThrow({ where: { id: version.id }, include: versionInclude }),
      );
      await this.record(tx, auth, { type: 'workflow', id }, undefined, { version: created.number, steps: created.steps });
      return created;
    });
  }

  async setCategory(auth: TenantAuth, categoryId: string, workflowId: string): Promise<CategoryWorkflowResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const category = await tx.category.findUnique({ where: { id: categoryId }, select: { workflowId: true } });
      if (!category) {
        throw new NotFoundException('Category not found');
      }
      await this.find(tx, workflowId);
      await tx.category.update({ where: { id: categoryId }, data: { workflowId } });
      await this.record(tx, auth, { type: 'category_workflow', id: categoryId }, { workflow_id: category.workflowId }, {
        workflow_id: workflowId,
      });
      return { category_id: categoryId, workflow_id: workflowId };
    });
  }

  async productWorkflow(tenantId: string, productId: string): Promise<ProductWorkflowResponse> {
    return this.prisma.inTenant(tenantId, (tx) => this.productView(tx, productId));
  }

  async setProduct(auth: TenantAuth, productId: string, workflowId: string): Promise<ProductWorkflowResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const before = await this.productView(tx, productId);
      await this.find(tx, workflowId);
      await tx.product.update({ where: { id: productId }, data: { workflowId } });
      const after = await this.productView(tx, productId);
      await this.record(tx, auth, { type: 'product_workflow', id: productId }, before, after);
      return after;
    });
  }

  /** The product goes back to its category's workflow. */
  async clearProduct(auth: TenantAuth, productId: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const before = await this.productView(tx, productId);
      await tx.product.update({ where: { id: productId }, data: { workflowId: null } });
      await this.record(tx, auth, { type: 'product_workflow', id: productId }, before, await this.productView(tx, productId));
    });
  }

  private async productView(tx: Prisma.TransactionClient, productId: string): Promise<ProductWorkflowResponse> {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { workflow: true, category: { select: { workflow: true } } },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    const workflow = product.workflow ?? product.category.workflow;
    return {
      product_id: productId,
      workflow: workflow ? { id: workflow.id, key: workflow.key, name: workflow.name } : null,
      own: product.workflow !== null,
    };
  }

  /**
   * Row-level security hides other workspaces' rows, so a foreign id is simply not found. Inactive
   * defects can't be added to a step.
   */
  private async checkReferences(tx: Prisma.TransactionClient, input: WorkflowStepsInput): Promise<void> {
    const stepTypeIds = [...new Set(input.steps.map((step) => step.step_type_id))];
    if ((await tx.stepType.count({ where: { id: { in: stepTypeIds } } })) !== stepTypeIds.length) {
      throw new NotFoundException('Step type not found');
    }
    const defectIds = [...new Set(input.steps.flatMap((step) => step.defects.map((defect) => defect.defect_id)))];
    if ((await tx.defect.count({ where: { id: { in: defectIds }, active: true } })) !== defectIds.length) {
      throw new NotFoundException('Defect not found, or not active');
    }
    const sopIds = [...new Set(input.steps.flatMap((step) => (step.sop_file_version_id ? [step.sop_file_version_id] : [])))];
    if ((await tx.fileVersion.count({ where: { id: { in: sopIds } } })) !== sopIds.length) {
      throw new NotFoundException('SOP file version not found');
    }
  }

  private async toVersion(tx: Prisma.TransactionClient, version: VersionRow): Promise<WorkflowVersionResponse> {
    const configs = version.steps.map((step) => step.config as StepConfig);
    const defectIds = [...new Set(configs.flatMap((config) => config.defects.map((defect) => defect.defect_id)))];
    const defects = new Map((await tx.defect.findMany({ where: { id: { in: defectIds } } })).map((row) => [row.id, row]));
    return {
      workflow_id: version.workflowId,
      number: version.number,
      created_at: version.createdAt.toISOString(),
      steps: version.steps.map((step, index) => toStep(step, configs[index], defects)),
    };
  }

  private async find(tx: Prisma.TransactionClient, id: string): Promise<Workflow> {
    const workflow = await tx.workflow.findUnique({ where: { id } });
    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }
    return workflow;
  }

  private async record(
    tx: Prisma.TransactionClient,
    auth: TenantAuth,
    subject: { type: string; id: string },
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'workflow.changed',
      subject,
      before: before as Prisma.InputJsonValue | undefined,
      after: after as Prisma.InputJsonValue,
    });
  }
}

const versionInclude = { steps: { include: { stepType: true }, orderBy: { position: 'asc' } } } as const;

function toSummary(row: Workflow, version: number | null): WorkflowSummaryResponse {
  return { id: row.id, key: row.key, name: row.name, version };
}

function toStep(
  step: WorkflowStepRow,
  config: StepConfig,
  defects: Map<string, { key: string; name: string }>,
): WorkflowStepResponse {
  return {
    id: step.id,
    position: step.position,
    key: step.key,
    name: step.name,
    step_type: { id: step.stepType.id, key: step.stepType.key, name: step.stepType.name, priced: step.stepType.summaryGroup !== null },
    checklist: config.checklist,
    defects: config.defects.map((defect) => ({
      defect_id: defect.defect_id,
      key: defects.get(defect.defect_id)!.key,
      name: defects.get(defect.defect_id)!.name,
      outcome: defect.outcome,
      rework_to: defect.rework_to ?? null,
    })),
    rework_targets: config.rework_targets,
    pass: config.pass,
    fail: config.fail,
    sop_file_version_id: step.sopFileVersionId,
    expected_minutes: step.expectedMinutes?.toFixed() ?? null,
    customer: config.customer,
  };
}
