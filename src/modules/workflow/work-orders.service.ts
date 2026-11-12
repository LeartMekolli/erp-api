import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
import { customerView, groupProgress, inRework, stepTotals } from './progress';
import type { GroupProgress, MoveFacts, StepTotals, TransitionFacts } from './progress';
import { ensureDraw, toInspect } from './sampling';
import { barredStepIds } from './step-skills';
import type { StepConfig } from './workflow-config';
import { WORK_ORDER_STATUSES } from './work-order-response';
import type {
  CustomerViewResponse,
  GroupResponse,
  LastMove,
  TransitionListItem,
  TransitionResponse,
  WorkOrderDetailResponse,
  WorkOrderListItem,
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
  /** Only the pieces the caller may pass or fail where they are (`may_work`). */
  workable: z.literal('true').optional(),
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
  /** `false`: only passes of pieces left out of a step's sample. */
  inspected: z.enum(['true', 'false']).optional(),
  /** From this moment on, inclusive. */
  from: z.iso.datetime({ offset: true }).optional(),
  /** Before this moment. */
  to: z.iso.datetime({ offset: true }).optional(),
});
export type TransitionQuery = z.infer<typeof transitionQuerySchema>;

/** What a group starts from: a quote, an order line, or a claimed line it remakes. */
export type GroupSourceType = 'quote' | 'order_line' | 'claim_line';

/** What a group of pieces starts from: a quote now, an order line once Orders exists. */
export interface StartInput {
  workflowVersionId: string;
  quantity: number;
  /** The step types the source priced; null runs every step. */
  chainStepTypeIds: string[] | null;
  source: { type: GroupSourceType; id: string };
  /** The quote the pieces were priced by, whichever source started them; Partners reads it. */
  quoteId?: string | null;
  productId?: string | null;
  fileVersionId?: string | null;
  customerId?: string | null;
  /** The assembly's group, for a part's: its pieces wait for every part (Orders spec, goal 6). */
  parentGroupId?: string | null;
  createdByUserId: string;
}

type GroupRow = WorkOrderGroup & { workflowVersion: { number: number; workflow: { id: string; name: string } } };

/**
 * Runs inside the transaction that starts a quote's group, once the group exists, so another module
 * can add to the start or refuse it by throwing, which creates nothing. What it returns runs after
 * commit. Partners uses it for a workshop the customer picked, so Workflow never depends on Partners.
 * `remake`: the group remakes claimed pieces, so the quote's picked workshop and cost don't apply.
 */
export type StartHook = (
  tx: Prisma.TransactionClient,
  started: { groupId: string; quote: Quote; userId: string; tenantId: string; remake: boolean },
) => Promise<(() => Promise<void>) | undefined>;

/** A group whose pieces were cancelled, as its cancel hooks hear of it. */
export interface CancelledGroup {
  groupId: string;
  userId: string;
  /** What a partner that had accepted the job is owed for it; nothing when left out. */
  partnerOwed?: { amount: string; reason: string };
}

/**
 * Runs inside the transaction that cancels a group's pieces, under the group's lock, so another
 * module can follow. Partners uses it to let go of the job's partner, so Workflow never depends on Partners.
 */
export type CancelHook = (tx: Prisma.TransactionClient, cancelled: CancelledGroup) => Promise<void>;

/** Groups of pieces and the pieces themselves: one work order per piece (F3). */
@Injectable()
export class WorkOrdersService {
  private readonly logger = new Logger(WorkOrdersService.name);
  private readonly startHooks: StartHook[] = [];
  private readonly cancelHooks: CancelHook[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  registerStartHook(hook: StartHook): void {
    this.startHooks.push(hook);
  }

  registerCancelHook(hook: CancelHook): void {
    this.cancelHooks.push(hook);
  }

  /**
   * Cancels every unfinished piece of the groups, each recorded as a correction to `cancelled` (as a
   * restored piece's replacement is), then runs the cancel hooks per group. Locks as a move does, the
   * pieces in id order and then their groups, so a move and a cancel at once can't deadlock.
   */
  async cancelGroups(
    tx: Prisma.TransactionClient,
    groups: { id: string; partnerOwed?: CancelledGroup['partnerOwed'] }[],
    userId: string,
    comment: string,
  ): Promise<void> {
    if (groups.length === 0) return;
    const groupIds = Prisma.join([...new Set(groups.map((group) => group.id))].sort().map((id) => Prisma.sql`${id}::uuid`));
    // NO KEY, as a move locks them, so a move's sample drawing one of these pieces can check its key at commit.
    await tx.$queryRaw`SELECT id FROM work_order WHERE group_id IN (${groupIds}) ORDER BY id FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT id FROM work_order_group WHERE id IN (${groupIds}) ORDER BY id FOR UPDATE`;

    const active = await tx.workOrder.findMany({ where: { groupId: { in: groups.map((group) => group.id) }, status: 'active' } });
    if (active.length > 0) {
      // One action: every piece this call cancels shares an id.
      const moveId = newId();
      await tx.transition.createMany({
        data: active.map((piece) => ({
          id: newId(),
          moveId,
          workOrderId: piece.id,
          kind: 'correction',
          fromStepId: piece.currentStepId,
          toStepId: null,
          fromStatus: 'active',
          toStatus: 'cancelled',
          comment,
          actorUserId: userId,
          // Not work done for a partner: nothing to credit.
          partnerId: null,
        })),
      });
      await tx.workOrder.updateMany({
        where: { id: { in: active.map((piece) => piece.id) } },
        data: { status: 'cancelled', currentStepId: null },
      });
    }
    for (const group of groups) {
      for (const hook of this.cancelHooks) {
        await hook(tx, { groupId: group.id, userId, partnerOwed: group.partnerOwed });
      }
    }
  }

  /** Starts a saved quote's pieces on its product's current workflow (B5). */
  async startFromQuote(auth: TenantAuth, quoteId: string): Promise<GroupResponse> {
    let afterCommit: (() => Promise<void>)[] = [];
    let started: GroupResponse;
    try {
      started = await this.prisma.inTenant(auth.tenantId, async (tx) => {
        // Row-level security hides other workspaces' quotes, so a foreign id is simply not found.
        const quote = await tx.quote.findUnique({ where: { id: quoteId } });
        if (!quote) {
          throw new NotFoundException('Quote not found');
        }
        const result = await this.startQuoted(tx, auth, quote, { type: 'quote', id: quoteId });
        afterCommit = result.afterCommit;
        return result.group;
      });
    } catch (error) {
      // Two starts of one quote at once: the second meets the unique source.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Production has already started for this quote');
      }
      throw error;
    }
    // The start has committed: a failure from here on (telling someone) must not report it as failed.
    for (const after of afterCommit) {
      try {
        await after();
      } catch (error) {
        this.logger.error({ err: error, quoteId }, 'a step after starting a quote failed');
      }
    }
    return started;
  }

  /**
   * Starts a quote's pieces inside the caller's transaction, for the quote itself or for an order line
   * priced by it (Orders plan, Task 3), and runs the start hooks, which may refuse by throwing. A quote
   * started on its own must still hold; an order checks its quotes when it is placed. What it returns
   * in `afterCommit` is for the caller to run once its transaction has committed. A remake (Orders 3
   * spec, goal 3) starts `quantity` pieces of the quote, from its claim line.
   */
  async startQuoted(
    tx: Prisma.TransactionClient,
    auth: Pick<TenantAuth, 'tenantId' | 'userId'>,
    quote: Quote,
    source: { type: GroupSourceType; id: string },
    options: { parentGroupId?: string; quantity?: number; remake?: { claimLineId: string } } = {},
  ): Promise<{ group: GroupResponse; afterCommit: (() => Promise<void>)[] }> {
    const remake = options.remake !== undefined;
    // A picked workshop's job is handed over by a start hook; without one it would silently be made in-house.
    if (quote.partnerId && !remake && this.startHooks.length === 0) {
      throw new InternalServerErrorException('This process cannot hand jobs to partners');
    }
    if (source.type === 'quote' && quote.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException('The quote has expired; quote again to start production');
    }
    const quantity = options.quantity ?? quote.quantity;
    if (quantity > MAX_PIECES) {
      throw new BadRequestException(`A group holds at most ${MAX_PIECES} pieces`);
    }
    if (await tx.workOrderGroup.findFirst({ where: { sourceType: source.type, sourceId: source.id } })) {
      throw new ConflictException(
        { quote: 'Production has already started for this quote', order_line: 'Production has already started for this order line', claim_line: 'The claimed line is being made again already' }[
          source.type
        ],
      );
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
      quantity,
      chainStepTypeIds: chain,
      source,
      quoteId: quote.id,
      productId: quote.productId,
      fileVersionId: inputs.file_version_id,
      customerId: quote.customerId,
      parentGroupId: options.parentGroupId ?? null,
      createdByUserId: auth.userId,
    });
    const afterCommit: (() => Promise<void>)[] = [];
    for (const hook of this.startHooks) {
      const after = await hook(tx, { groupId: group.id, quote, userId: auth.userId, tenantId: auth.tenantId, remake });
      if (after) afterCommit.push(after);
    }
    return { group, afterCommit };
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
        quoteId: input.quoteId ?? null,
        productId: input.productId ?? null,
        fileVersionId: input.fileVersionId ?? null,
        customerId: input.customerId ?? null,
        quantity: input.quantity,
        chainStepTypeIds: input.chainStepTypeIds ?? Prisma.DbNull,
        parentGroupId: input.parentGroupId ?? null,
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
    // When the first step samples, every piece has just reached it (Workflow 2 spec, goal 3).
    await ensureDraw(tx, group, steps.find((step) => step.id === path[0])!);
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
      return this.customerProgress(tx, group);
    });
  }

  /** The customer view of a group inside a caller's transaction, such as an order's line (Orders spec, goal 10). */
  async customerProgress(tx: Prisma.TransactionClient, group: WorkOrderGroup): Promise<CustomerViewResponse> {
    const steps = await this.versionSteps(tx, group.workflowVersionId);
    const byId = new Map(steps.map((step) => [step.id, step]));
    const path = pathFor(stepsForPath(steps), chainOf(group)).map((stepId) => ({
      id: stepId,
      customer: (byId.get(stepId)!.config as StepConfig).customer,
    }));
    const { pieces, histories } = await this.piecesWithHistory(tx, group.id);
    return customerView(
      path,
      group.quantity,
      pieces.map((piece) => ({ ...piece, history: histories.get(piece.id) ?? [] })),
    );
  }

  /**
   * Pieces in the order they started, filtered by group, current step or status, each marked with whether
   * the caller may work it (Workflow 2 spec, goal 13); `workable=true` keeps only those.
   */
  async list(auth: TenantAuth, query: WorkOrderQuery): Promise<Page<WorkOrderListItem>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    const mayMove = auth.permissions.has('workflow.move');
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const barred = mayMove ? await barredStepIds(tx, auth) : new Set<string>();
      let workable: Prisma.WorkOrderWhereInput = {};
      if (query.workable === 'true') {
        // Without the move permission, nothing is workable.
        workable = mayMove ? { status: 'active', currentStepId: { notIn: [...barred] } } : { id: { in: [] } };
      }
      // First-in-line customers' groups first (Customers 2 spec, goal 17), then in id order. A cursor from
      // before ranks existed carries none: the rank its piece's group has now is taken.
      let page: Prisma.WorkOrderWhereInput = {};
      if (after) {
        const rank =
          after.rank ??
          (await tx.workOrder.findUnique({ where: { id: after.id }, select: { group: { select: { queueRank: true } } } }))?.group.queueRank ??
          0;
        page = { OR: [{ group: { queueRank: { lt: rank } } }, { group: { queueRank: rank }, id: { gt: after.id } }] };
      }
      const rows = await tx.workOrder.findMany({
        where: {
          AND: [
            {
              ...(query.group_id ? { groupId: query.group_id } : {}),
              ...(query.step_key ? { currentStep: { key: query.step_key } } : {}),
              ...(query.status ? { status: query.status } : {}),
            },
            page,
            workable,
          ],
        },
        orderBy: [{ group: { queueRank: 'desc' } }, { id: 'asc' }],
        take: query.limit + 1,
        include: pieceInclude,
      });
      const data = rows.slice(0, query.limit);
      const last = data.at(-1);
      const inspect = await toInspect(tx, data);
      const moves = await this.moveSummaries(tx, data);
      return {
        data: data.map((row) => ({
          ...toWorkOrder(row),
          to_inspect: inspect.get(row.id) ?? null,
          may_work: mayMove && row.status === 'active' && !barred.has(row.currentStepId!),
          ...(moves.get(row.id) ?? { in_rework: false, last_move: null }),
        })),
        next_cursor: rows.length > query.limit && last ? encodeCursor({ id: last.id, rank: last.group.queueRank }, secret) : null,
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
          ...(query.inspected ? { inspected: query.inspected === 'true' } : {}),
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
      const sopId = row.currentStepId ? (byId.get(row.currentStepId)?.sopFileVersionId ?? null) : null;
      const sop = sopId ? await tx.fileVersion.findUniqueOrThrow({ where: { id: sopId }, select: { id: true, fileId: true } }) : null;
      return {
        ...toWorkOrder(row),
        to_inspect: (await toInspect(tx, [row])).get(row.id) ?? null,
        path: path.map((stepId) => ({ key: byId.get(stepId)!.key, name: byId.get(stepId)!.name })),
        sop: sop ? { file_id: sop.fileId, file_version_id: sop.id } : null,
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
    const totals = stepTotals(path, [...histories.values()].flat());
    return {
      id: group.id,
      workflow: { id: group.workflowVersion.workflow.id, name: group.workflowVersion.workflow.name, version: group.workflowVersion.number },
      source: { type: group.sourceType as GroupResponse['source']['type'], id: group.sourceId },
      product_id: group.productId,
      customer_id: group.customerId,
      quantity: group.quantity,
      pieces: progress.pieces,
      steps: await this.withChecks(tx, path, progress.steps, totals),
    };
  }

  /**
   * Each step of the path with its checks: at most two more queries, for the defects' names and the
   * latest checks, and none when the group has no checks yet.
   */
  private async withChecks(
    tx: Prisma.TransactionClient,
    path: string[],
    steps: GroupProgress['steps'],
    totals: Map<string, StepTotals>,
  ): Promise<GroupResponse['steps']> {
    const all = [...totals.values()];
    const defectIds = [...new Set(all.flatMap((step) => [...step.defectCounts.keys()]))];
    const latestIds = all.flatMap((step) => (step.latestCheckId === null ? [] : [step.latestCheckId]));
    const defects =
      defectIds.length > 0 ? await tx.defect.findMany({ where: { id: { in: defectIds } }, select: { id: true, key: true, name: true } }) : [];
    const checks =
      latestIds.length > 0
        ? await tx.transition.findMany({
            where: { id: { in: latestIds } },
            select: {
              id: true,
              createdAt: true,
              actor: nameRef,
              partner: nameRef,
              photos: { orderBy: { id: 'asc' }, include: { fileVersion: { select: { fileId: true } } } },
            },
          })
        : [];
    const defectById = new Map(defects.map((defect) => [defect.id, defect]));
    const checkById = new Map(checks.map((check) => [check.id, check]));
    return steps.map((step, index) => {
      const total = totals.get(path[index])!;
      const check = total.latestCheckId === null ? undefined : checkById.get(total.latestCheckId);
      return {
        ...step,
        passed: total.passed,
        failed: total.failed,
        not_inspected: total.not_inspected,
        defects: [...total.defectCounts]
          .map(([id, count]) => ({ key: defectById.get(id)!.key, name: defectById.get(id)!.name, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        latest_check: check
          ? {
              actor: check.actor,
              partner: check.partner,
              created_at: check.createdAt.toISOString(),
              photos: check.photos.map((photo) => ({ file_id: photo.fileVersion.fileId, file_version_id: photo.fileVersionId })),
            }
          : null,
      };
    });
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
      select: { id: true, workOrderId: true, kind: true, outcome: true, fromStepId: true, defectId: true, inspected: true },
      orderBy: { id: 'asc' },
    });
    const histories = new Map<string, MoveFacts[]>();
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

  /**
   * Whether each piece is being redone, and its last move, in two queries whatever the page size: the
   * pieces' move facts in move order, then their last moves with names. Only an active piece is in rework;
   * a scrapped or cancelled one can keep a rework open in its history.
   */
  private async moveSummaries(
    tx: Prisma.TransactionClient,
    pieces: { id: string; status: string }[],
  ): Promise<Map<string, { in_rework: boolean; last_move: LastMove | null }>> {
    const facts = await tx.transition.findMany({
      where: { workOrderId: { in: pieces.map((piece) => piece.id) } },
      select: { id: true, workOrderId: true, kind: true, outcome: true, fromStepId: true },
      orderBy: { id: 'asc' },
    });
    const histories = new Map<string, (TransitionFacts & { id: string })[]>();
    for (const row of facts) {
      const history = histories.get(row.workOrderId);
      if (history) {
        history.push(row);
      } else {
        histories.set(row.workOrderId, [row]);
      }
    }
    const lastIds = [...histories.values()].map((history) => history.at(-1)!.id);
    const lasts =
      lastIds.length > 0
        ? await tx.transition.findMany({
            where: { id: { in: lastIds } },
            select: { id: true, kind: true, outcome: true, createdAt: true, fromStep: stepRef, defect: stepRef, actor: nameRef, partner: nameRef },
          })
        : [];
    const byId = new Map(lasts.map((row) => [row.id, row]));
    return new Map(
      pieces.map((piece) => {
        const history = histories.get(piece.id) ?? [];
        const last = history.length > 0 ? byId.get(history.at(-1)!.id) : undefined;
        return [
          piece.id,
          {
            in_rework: piece.status === 'active' && inRework(history) !== null,
            last_move: last
              ? {
                  kind: last.kind as LastMove['kind'],
                  outcome: last.outcome as LastMove['outcome'],
                  from_step: last.fromStep,
                  defect: last.defect,
                  actor: last.actor,
                  partner: last.partner,
                  created_at: last.createdAt.toISOString(),
                }
              : null,
          },
        ];
      }),
    );
  }

  private versionSteps(tx: Prisma.TransactionClient, versionId: string): Promise<WorkflowStepRow[]> {
    return tx.workflowStep.findMany({ where: { versionId }, include: { stepType: true }, orderBy: { position: 'asc' } });
  }
}

export const pieceInclude = {
  currentStep: { select: { id: true, key: true, name: true } },
  group: { select: { quantity: true, queueRank: true } },
} as const;

const stepRef = { select: { id: true, key: true, name: true } } as const;
const nameRef = { select: { id: true, name: true } } as const;

export const transitionInclude = {
  // With its config, to name the answers: a version's steps are never changed, so it is what staff answered.
  fromStep: { select: { id: true, key: true, name: true, config: true } },
  toStep: stepRef,
  defect: stepRef,
  actor: nameRef,
  partner: nameRef,
  answers: { orderBy: { id: 'asc' } },
  photos: { orderBy: { id: 'asc' }, include: { fileVersion: { select: { fileId: true } } } },
} as const satisfies Prisma.TransitionInclude;

type TransitionRow = Prisma.TransitionGetPayload<{ include: typeof transitionInclude }>;

/**
 * An answer with the names the step gave its item and, for a choice, the chosen option. An item no longer
 * on the step is named by its key.
 */
function readableAnswer(answer: TransitionRow['answers'][number], checklist: StepConfig['checklist'] | undefined): TransitionResponse['answers'][number] {
  const item = checklist?.find((one) => one.key === answer.itemKey);
  const option = item?.kind === 'choice' ? item.options.find((one) => one.key === answer.value) : undefined;
  return {
    item: answer.itemKey,
    label: item?.label ?? answer.itemKey,
    value: answer.value,
    value_label: option?.label ?? null,
    note: answer.note,
    passing: answer.passing,
  };
}

export function toTransition(row: TransitionRow): TransitionResponse {
  const checklist = row.fromStep ? (row.fromStep.config as StepConfig).checklist : undefined;
  return {
    id: row.id,
    move_id: row.moveId,
    kind: row.kind as TransitionResponse['kind'],
    outcome: row.outcome as TransitionResponse['outcome'],
    from_step: row.fromStep ? { id: row.fromStep.id, key: row.fromStep.key, name: row.fromStep.name } : null,
    to_step: row.toStep,
    defect: row.defect,
    override_reason: row.overrideReason,
    comment: row.comment,
    answers: row.answers.map((answer) => readableAnswer(answer, checklist)),
    photo_file_version_ids: row.photos.map((photo) => photo.fileVersionId),
    photos: row.photos.map((photo) => ({ file_id: photo.fileVersion.fileId, file_version_id: photo.fileVersionId })),
    actor: row.actor,
    partner: row.partner,
    inspected: row.inspected,
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
