import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { newId } from '../../common/ids/uuid';
import { decodeCursor, encodeCursor } from '../../common/pagination/cursor';
import type { Page } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { Quote, WorkOrder, WorkOrderGroup } from '../../generated/prisma/client';
import type { TenantAuth } from '../identity/auth-context';
import { keySchema } from '../pricing/decimals';
import { missingStepTypes, resolveWorkflow } from './coverage';
import type { WorkflowStepRow } from './coverage';
import { pathFor } from './path';
import { customerView, groupProgress } from './progress';
import type { TransitionFacts } from './progress';
import type { StepConfig } from './workflow-config';
import { WORK_ORDER_STATUSES } from './work-order-response';
import type {
  CustomerViewResponse,
  GroupResponse,
  TransitionListItem,
  TransitionResponse,
  WorkOrderDetailResponse,
  WorkOrderResponse,
  WorkOrderStatus,
} from './work-order-response';

/** More pieces than this in one group would be a typo, not an order (Workflow/QC plan, limits). */
export const MAX_PIECES = 10_000;

export const startGroupSchema = z.object({ quote_id: z.uuid() });

export const workOrderQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  group_id: z.uuid().optional(),
  step_key: keySchema.optional(),
  status: z.enum(WORK_ORDER_STATUSES).optional(),
});
export type WorkOrderQuery = z.infer<typeof workOrderQuerySchema>;

export const transitionQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  work_order_id: z.uuid().optional(),
  group_id: z.uuid().optional(),
  /** The step the move was made at. */
  step_key: keySchema.optional(),
  defect_key: keySchema.optional(),
  /** The design file the piece's group was started with (D21). */
  file_version_id: z.uuid().optional(),
  actor_user_id: z.uuid().optional(),
  /** From this moment on, inclusive. */
  from: z.iso.datetime({ offset: true }).optional(),
  /** Before this moment. */
  to: z.iso.datetime({ offset: true }).optional(),
});
export type TransitionQuery = z.infer<typeof transitionQuerySchema>;

/** What a group of pieces starts from: a quote now, an order line once Orders exists. */
export interface StartInput {
  workflowVersionId: string;
  quantity: number;
  /** The step types the source priced; null runs every step. */
  chainStepTypeIds: string[] | null;
  source: { type: 'quote' | 'order_line'; id: string };
  productId?: string | null;
  fileVersionId?: string | null;
  customerId?: string | null;
  createdByUserId: string;
}

type GroupRow = WorkOrderGroup & { workflowVersion: { number: number; workflow: { id: string; name: string } } };

/**
 * Runs inside the transaction that starts a quote's group, once the group exists, so another module
 * can add to the start or refuse it by throwing, which creates nothing. What it returns runs after
 * commit. Partners uses it for a workshop the customer picked, so Workflow never depends on Partners.
 */
export type StartHook = (
  tx: Prisma.TransactionClient,
  started: { groupId: string; quote: Quote; userId: string; tenantId: string },
) => Promise<(() => Promise<void>) | undefined>;

/** Groups of pieces and the pieces themselves: one work order per piece (F3). */
@Injectable()
export class WorkOrdersService {
  private readonly startHooks: StartHook[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  registerStartHook(hook: StartHook): void {
    this.startHooks.push(hook);
  }

  /** Starts a saved quote's pieces on its product's current workflow (B5). */
  async startFromQuote(auth: TenantAuth, quoteId: string): Promise<GroupResponse> {
    const afterCommit: (() => Promise<void>)[] = [];
    try {
      const started = await this.prisma.inTenant(auth.tenantId, async (tx) => {
        // Row-level security hides other workspaces' quotes, so a foreign id is simply not found.
        const quote = await tx.quote.findUnique({ where: { id: quoteId } });
        if (!quote) {
          throw new NotFoundException('Quote not found');
        }
        if (quote.expiresAt.getTime() <= Date.now()) {
          throw new ConflictException('The quote has expired; quote again to start production');
        }
        if (quote.quantity > MAX_PIECES) {
          throw new BadRequestException(`A group holds at most ${MAX_PIECES} pieces`);
        }
        if (await tx.workOrderGroup.findFirst({ where: { sourceType: 'quote', sourceId: quoteId } })) {
          throw new ConflictException('Production has already started for this quote');
        }

        const workflow = await resolveWorkflow(tx, quote.productId);
        if (!workflow) {
          throw new ConflictException('The product has no workflow');
        }
        // The steps the quote priced, by key: step type keys never change.
        const keys = (quote.breakdown as { steps: { key: string }[] }).steps.map((step) => step.key);
        const types = await tx.stepType.findMany({ where: { key: { in: keys } }, select: { id: true, key: true } });
        const idOf = new Map(types.map((type) => [type.key, type.id]));
        const keyOf = new Map(types.map((type) => [type.id, type.key]));
        // Step types are never deleted, so every key the quote priced still names one.
        const chain = keys.map((key) => idOf.get(key)!);
        const missing = missingStepTypes(workflow.steps, chain);
        if (missing.length > 0) {
          const names = missing.map((id) => keyOf.get(id)!);
          throw new ConflictException(`Workflow ${workflow.name} has no ${names.join(', ')} step`);
        }

        const inputs = quote.inputs as { file_version_id: string | null };
        const group = await this.start(tx, {
          workflowVersionId: workflow.versionId,
          quantity: quote.quantity,
          chainStepTypeIds: chain,
          source: { type: 'quote', id: quoteId },
          productId: quote.productId,
          fileVersionId: inputs.file_version_id,
          customerId: quote.customerId,
          createdByUserId: auth.userId,
        });
        for (const hook of this.startHooks) {
          const after = await hook(tx, { groupId: group.id, quote, userId: auth.userId, tenantId: auth.tenantId });
          if (after) afterCommit.push(after);
        }
        return group;
      });
      for (const after of afterCommit) {
        await after();
      }
      return started;
    } catch (error) {
      // Two starts of one quote at once: the second meets the unique source.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Production has already started for this quote');
      }
      throw error;
    }
  }

  /** Creates pieces 1..quantity at the first step of their path. The entry point for Orders and tests. */
  async start(tx: Prisma.TransactionClient, input: StartInput): Promise<GroupResponse> {
    const steps = await this.versionSteps(tx, input.workflowVersionId);
    const path = pathFor(stepsForPath(steps), input.chainStepTypeIds);
    if (path.length === 0) {
      throw new ConflictException('The workflow has no step for these pieces');
    }
    const group = await tx.workOrderGroup.create({
      data: {
        workflowVersionId: input.workflowVersionId,
        sourceType: input.source.type,
        sourceId: input.source.id,
        productId: input.productId ?? null,
        fileVersionId: input.fileVersionId ?? null,
        customerId: input.customerId ?? null,
        quantity: input.quantity,
        chainStepTypeIds: input.chainStepTypeIds ?? Prisma.DbNull,
        createdByUserId: input.createdByUserId,
      },
    });
    // Ids in number order, so a list by id lists the pieces in order.
    await tx.workOrder.createMany({
      data: Array.from({ length: input.quantity }, (_, index) => ({
        id: newId(),
        groupId: group.id,
        number: index + 1,
        currentStepId: path[0],
      })),
    });
    return this.groupView(tx, group.id);
  }

  async group(tenantId: string, id: string): Promise<GroupResponse> {
    return this.prisma.inTenant(tenantId, (tx) => this.groupView(tx, id));
  }

  /** Exactly what a customer will see of the group: a staff-only preview for now (B7). */
  async customerView(tenantId: string, id: string): Promise<CustomerViewResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const group = await tx.workOrderGroup.findUnique({ where: { id } });
      if (!group) {
        throw new NotFoundException('Group not found');
      }
      const steps = await this.versionSteps(tx, group.workflowVersionId);
      const byId = new Map(steps.map((step) => [step.id, step]));
      const path = pathFor(stepsForPath(steps), chainOf(group)).map((stepId) => ({
        id: stepId,
        customer: (byId.get(stepId)!.config as StepConfig).customer,
      }));
      const { pieces, histories } = await this.piecesWithHistory(tx, id);
      return customerView(
        path,
        group.quantity,
        pieces.map((piece) => ({ ...piece, history: histories.get(piece.id) ?? [] })),
      );
    });
  }

  /** Pieces in the order they started, filtered by group, current step or status. */
  async list(tenantId: string, query: WorkOrderQuery): Promise<Page<WorkOrderResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.workOrder.findMany({
        where: {
          ...(after ? { id: { gt: after.id } } : {}),
          ...(query.group_id ? { groupId: query.group_id } : {}),
          ...(query.step_key ? { currentStep: { key: query.step_key } } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: { id: 'asc' },
        take: query.limit + 1,
        include: pieceInclude,
      });
      const data = rows.slice(0, query.limit);
      const last = data.at(-1);
      return {
        data: data.map(toWorkOrder),
        next_cursor: rows.length > query.limit && last ? encodeCursor({ id: last.id }, secret) : null,
      };
    });
  }

  /** The QC history (ADR 0003 §7): every move, newest first, filtered. */
  async transitions(tenantId: string, query: TransitionQuery): Promise<Page<TransitionListItem>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    const group = {
      ...(query.group_id ? { id: query.group_id } : {}),
      ...(query.file_version_id ? { fileVersionId: query.file_version_id } : {}),
    };
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.transition.findMany({
        where: {
          ...(after ? { id: { lt: after.id } } : {}),
          ...(query.work_order_id ? { workOrderId: query.work_order_id } : {}),
          ...(Object.keys(group).length > 0 ? { workOrder: { group } } : {}),
          ...(query.step_key ? { fromStep: { key: query.step_key } } : {}),
          ...(query.defect_key ? { defect: { key: query.defect_key } } : {}),
          ...(query.actor_user_id ? { actorUserId: query.actor_user_id } : {}),
          ...(query.from || query.to
            ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lt: new Date(query.to) } : {}) } }
            : {}),
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        include: { ...transitionInclude, workOrder: { select: { id: true, number: true, group: { select: { quantity: true } } } } },
      });
      const data = rows.slice(0, query.limit);
      const last = data.at(-1);
      return {
        data: data.map((row) => ({
          ...toTransition(row),
          work_order: { id: row.workOrder.id, label: `${row.workOrder.number}/${row.workOrder.group.quantity}` },
        })),
        next_cursor: rows.length > query.limit && last ? encodeCursor({ id: last.id }, secret) : null,
      };
    });
  }

  async get(tenantId: string, id: string): Promise<WorkOrderDetailResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const row = await tx.workOrder.findUnique({ where: { id }, include: { ...pieceInclude, group: true } });
      if (!row) {
        throw new NotFoundException('Work order not found');
      }
      const steps = await this.versionSteps(tx, row.group.workflowVersionId);
      const path = pathFor(stepsForPath(steps), chainOf(row.group));
      const byId = new Map(steps.map((step) => [step.id, step]));
      const history = await tx.transition.findMany({
        where: { workOrderId: id },
        include: transitionInclude,
        orderBy: { id: 'asc' },
      });
      return {
        ...toWorkOrder(row),
        path: path.map((stepId) => ({ key: byId.get(stepId)!.key, name: byId.get(stepId)!.name })),
        sop_file_version_id: row.currentStepId ? (byId.get(row.currentStepId)?.sopFileVersionId ?? null) : null,
        history: history.map(toTransition),
      };
    });
  }

  private async groupView(tx: Prisma.TransactionClient, id: string): Promise<GroupResponse> {
    const group: GroupRow | null = await tx.workOrderGroup.findUnique({
      where: { id },
      include: { workflowVersion: { select: { number: true, workflow: { select: { id: true, name: true } } } } },
    });
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    const steps = await this.versionSteps(tx, group.workflowVersionId);
    const path = pathFor(stepsForPath(steps), chainOf(group));
    const { pieces, histories } = await this.piecesWithHistory(tx, id);
    const byId = new Map(steps.map((step) => [step.id, step]));
    const progress = groupProgress(
      path.map((stepId) => byId.get(stepId)!),
      pieces.map((piece) => ({ ...piece, history: histories.get(piece.id) ?? [] })),
    );
    return {
      id: group.id,
      workflow: { id: group.workflowVersion.workflow.id, name: group.workflowVersion.workflow.name, version: group.workflowVersion.number },
      source: { type: group.sourceType as GroupResponse['source']['type'], id: group.sourceId },
      product_id: group.productId,
      customer_id: group.customerId,
      quantity: group.quantity,
      ...progress,
    };
  }

  /**
   * A group's pieces, and each piece's transitions in move order, read in two queries. Move order is id
   * order: ids are made while the move holds the piece's lock, whereas `created_at` is when the move's
   * transaction began, which can be before an earlier move that held the lock first.
   */
  private async piecesWithHistory(tx: Prisma.TransactionClient, groupId: string) {
    const pieces = await tx.workOrder.findMany({
      where: { groupId },
      select: { id: true, number: true, status: true, currentStepId: true, replacesId: true },
    });
    const transitions = await tx.transition.findMany({
      where: { workOrder: { groupId } },
      select: { workOrderId: true, kind: true, outcome: true, fromStepId: true },
      orderBy: { id: 'asc' },
    });
    const histories = new Map<string, TransitionFacts[]>();
    for (const row of transitions) {
      const history = histories.get(row.workOrderId);
      if (history) {
        history.push(row);
      } else {
        histories.set(row.workOrderId, [row]);
      }
    }
    return { pieces, histories };
  }

  private versionSteps(tx: Prisma.TransactionClient, versionId: string): Promise<WorkflowStepRow[]> {
    return tx.workflowStep.findMany({ where: { versionId }, include: { stepType: true }, orderBy: { position: 'asc' } });
  }
}

export const pieceInclude = {
  currentStep: { select: { id: true, key: true, name: true } },
  group: { select: { quantity: true } },
} as const;

const stepRef = { select: { id: true, key: true, name: true } } as const;

export const transitionInclude = {
  fromStep: stepRef,
  toStep: stepRef,
  defect: { select: { id: true, key: true, name: true } },
  actor: { select: { id: true, name: true } },
  partner: { select: { id: true, name: true } },
  answers: { orderBy: { id: 'asc' } },
  photos: { orderBy: { id: 'asc' } },
} as const satisfies Prisma.TransitionInclude;

type TransitionRow = Prisma.TransitionGetPayload<{ include: typeof transitionInclude }>;

export function toTransition(row: TransitionRow): TransitionResponse {
  return {
    id: row.id,
    kind: row.kind as TransitionResponse['kind'],
    outcome: row.outcome as TransitionResponse['outcome'],
    from_step: row.fromStep,
    to_step: row.toStep,
    defect: row.defect,
    override_reason: row.overrideReason,
    comment: row.comment,
    answers: row.answers.map((answer) => ({ item: answer.itemKey, value: answer.value, note: answer.note, passing: answer.passing })),
    photo_file_version_ids: row.photos.map((photo) => photo.fileVersionId),
    actor: row.actor,
    partner: row.partner,
    created_at: row.createdAt.toISOString(),
  };
}

export function stepsForPath(steps: WorkflowStepRow[]) {
  return steps.map((step) => ({
    id: step.id,
    stepTypeId: step.stepTypeId,
    priced: step.priced,
    position: step.position,
  }));
}

export function chainOf(group: WorkOrderGroup): string[] | null {
  return group.chainStepTypeIds === null ? null : (group.chainStepTypeIds as string[]);
}

type PieceRow = WorkOrder & { currentStep: { id: string; key: string; name: string } | null; group: { quantity: number } };

export function toWorkOrder(row: PieceRow): WorkOrderResponse {
  return {
    id: row.id,
    group_id: row.groupId,
    number: row.number,
    label: `${row.number}/${row.group.quantity}`,
    status: row.status as WorkOrderStatus,
    step: row.currentStep,
    replaces_id: row.replacesId,
    created_at: row.createdAt.toISOString(),
  };
}
