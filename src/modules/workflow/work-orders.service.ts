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
import type { CursorPayload } from '../../common/pagination/cursor';
import type { Page } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { Quote, WorkOrder, WorkOrderGroup } from '../../generated/prisma/client';
import type { TenantAuth } from '../identity/auth-context';
import { workspaceCalendar } from '../orders/needs-today';
import { groupPromise } from '../orders/order-lines';
import { keySchema } from '../pricing/decimals';
import { SettingsService } from '../settings/settings.service';
import { missingStepTypes, resolveWorkflow } from './coverage';
import { groupSummaries } from './group-summary';
import type { HoldReason } from './holds';
import { PIECE_SORTS, pieceFilterSchema, pieceWhere, workContext } from './piece-filters';
import type { PieceSort } from './piece-filters';
import type { MissingSkill } from './step-skills';
import type { WorkflowStepRow } from './coverage';
import { actionFacts, listActions, listActors, listMoves, transitionFilters } from './move-history';
import type { MoveHistoryQuery } from './move-history';
import type { MoveActorsResponse, MoveHistoryResponse, MoveListItem } from './move-history-response';
import { pathFor } from './path';
import { customerView, groupProgress, inRework, stepTotals } from './progress';
import type { GroupProgress, MoveFacts, StepTotals, TransitionFacts } from './progress';
import { ensureDraw, historiesOf, toInspect } from './sampling';
import { nameRef, stepRef, toTransition, transitionInclude } from './transition-rows';
import type { StepConfig } from './workflow-config';
import { WORK_ORDER_STATUSES } from './work-order-response';
import type {
  CustomerViewResponse,
  GroupResponse,
  LastMove,
  StepCountsResponse,
  StepGroup,
  TransitionListItem,
  WorkOrderDetailResponse,
  WorkOrderListItem,
  WorkOrderResponse,
  WorkOrderStatus,
} from './work-order-response';

/** More pieces than this in one group would be a typo, not an order (Workflow/QC plan, limits). */
export const MAX_PIECES = 10_000;

export const startGroupSchema = z.object({ quote_id: z.uuid() });

export const workOrderQuerySchema = pieceFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  group_id: z.uuid().optional(),
  step_key: keySchema.optional(),
  status: z.enum(WORK_ORDER_STATUSES).optional(),
  sort: z.enum(PIECE_SORTS).default('priority'),
});
export type WorkOrderQuery = z.infer<typeof workOrderQuerySchema>;

export const stepCountsQuerySchema = pieceFilterSchema.extend({ workflow_id: z.uuid() });
export type StepCountsQuery = z.infer<typeof stepCountsQuerySchema>;

export const stepGroupsQuerySchema = pieceFilterSchema.extend({
  workflow_id: z.uuid(),
  step_key: keySchema,
  sort: z.enum(PIECE_SORTS).default('priority'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type StepGroupsQuery = z.infer<typeof stepGroupsQuerySchema>;

const NO_DUE_DATE = 'none';
/** What a cursor through one move's rows carries, in piece order, so a newest-first cursor is refused. */
const PIECE_ORDER_CURSOR = 'move_pieces';
const byDue = (sort: PieceSort) => sort === 'due_on' || sort === '-due_on';
const asDay = (day: string) => new Date(`${day}T00:00:00Z`);
const dayOf = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : NO_DUE_DATE);

/** The work list's order: see `PIECE_SORTS`. Ties between groups break by rank, then by id. */
function piecesOrderBy(sort: PieceSort): Prisma.WorkOrderOrderByWithRelationInput[] {
  if (sort === 'started') return [{ id: 'asc' }];
  const ranked: Prisma.WorkOrderOrderByWithRelationInput[] = [{ group: { queueRank: 'desc' } }, { id: 'asc' }];
  if (!byDue(sort)) return ranked;
  return [{ group: { dueOn: { sort: sort === 'due_on' ? 'asc' : 'desc', nulls: 'last' } } }, ...ranked];
}

/** After a row of rank `rank` and id `id`, in rank order, among the pieces whose group matches `group`. */
const afterRanked = (group: Prisma.WorkOrderGroupWhereInput, rank: number, id: string): Prisma.WorkOrderWhereInput[] => [
  { group: { ...group, queueRank: { lt: rank } } },
  { group: { ...group, queueRank: rank }, id: { gt: id } },
];

/** Where a due date page starts, after the cursor's row; every undated piece comes after the dated ones. */
function duePageWhere(sort: PieceSort, after: CursorPayload): Prisma.WorkOrderWhereInput {
  const rank = after.rank!;
  if (after.key === NO_DUE_DATE) return { OR: afterRanked({ dueOn: null }, rank, after.id) };
  const day = asDay(after.key!);
  return {
    OR: [
      { group: { dueOn: sort === 'due_on' ? { gt: day } : { lt: day } } },
      ...afterRanked({ dueOn: day }, rank, after.id),
      { group: { dueOn: null } },
    ],
  };
}

/** Which list a cursor pages: the work list's pieces, or the groups at a step (`groups:` before the sort). */
type CursorList = 'pieces' | 'groups';
const madeFor = (list: CursorList, sort: PieceSort) => (list === 'groups' ? `groups:${sort}` : sort);

/** The cursor for `sort` on `list`, refused (400) when made for another sort or list, or when its key isn't that sort's. */
function piecesCursor(list: CursorList, sort: PieceSort, cursor: string, secret: string): CursorPayload {
  const after = decodeCursor(cursor, secret);
  // A work list cursor from before the sorts carries none: it was made for `priority`.
  const made = after.sort ?? 'priority';
  const ranked = sort !== 'started';
  const keyOk = byDue(sort)
    ? after.rank !== undefined && (after.key === NO_DUE_DATE || z.iso.date().safeParse(after.key).success)
    : after.key === undefined && (list === 'pieces' || !ranked || after.rank !== undefined);
  if (made !== madeFor(list, sort) || !keyOk) throw new BadRequestException('Invalid cursor: made for another sort or list');
  return after;
}

/** The order of a list of groups: the work list's sorts, with the group's own id where it has the piece's. */
function groupsOrderBy(sort: PieceSort): Prisma.WorkOrderGroupOrderByWithRelationInput[] {
  if (sort === 'started') return [{ id: 'asc' }];
  const ranked: Prisma.WorkOrderGroupOrderByWithRelationInput[] = [{ queueRank: 'desc' }, { id: 'asc' }];
  if (!byDue(sort)) return ranked;
  return [{ dueOn: { sort: sort === 'due_on' ? 'asc' : 'desc', nulls: 'last' } }, ...ranked];
}

/** Where a page of groups starts, after the cursor's group, as `piecesOrderBy`'s pages do for pieces. */
function groupsPageWhere(sort: PieceSort, after: CursorPayload): Prisma.WorkOrderGroupWhereInput {
  if (sort === 'started') return { id: { gt: after.id } };
  const rank = after.rank!;
  const ranked = (on: Prisma.WorkOrderGroupWhereInput): Prisma.WorkOrderGroupWhereInput[] => [
    { ...on, queueRank: { lt: rank } },
    { ...on, queueRank: rank, id: { gt: after.id } },
  ];
  if (!byDue(sort)) return { OR: ranked({}) };
  if (after.key === NO_DUE_DATE) return { OR: ranked({ dueOn: null }) };
  const day = asDay(after.key!);
  return { OR: [{ dueOn: sort === 'due_on' ? { gt: day } : { lt: day } }, ...ranked({ dueOn: day }), { dueOn: null }] };
}

/** What the next page's cursor carries for `sort` on `list`: a work list `priority` cursor stays as it was before the sorts. */
function piecesCursorPayload(
  list: CursorList,
  sort: PieceSort,
  row: { id: string; group: { queueRank: number; dueOn: Date | null } },
): CursorPayload {
  const made = madeFor(list, sort);
  if (sort === 'priority') return list === 'pieces' ? { id: row.id, rank: row.group.queueRank } : { id: row.id, rank: row.group.queueRank, sort: made };
  if (sort === 'started') return { id: row.id, sort: made };
  return { id: row.id, rank: row.group.queueRank, sort: made, key: dayOf(row.group.dueOn) };
}

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
  /** Only the rows one request wrote. */
  move_id: z.uuid().optional(),
});
export type TransitionQuery = z.infer<typeof transitionQuerySchema>;

export const moveListQuerySchema = transitionQuerySchema.extend({
  kind: z.enum(['pass', 'fail', 'correction']).optional(),
  workflow_id: pieceFilterSchema.shape.workflow_id,
  q: pieceFilterSchema.shape.q,
});
export type MoveListQuery = z.infer<typeof moveListQuerySchema>;

/** Who has made a move, for History's Person filter: `workflow_id` keeps any version of that workflow. */
export const moveActorsQuerySchema = z.object({
  workflow_id: pieceFilterSchema.shape.workflow_id,
});
export type MoveActorsQuery = z.infer<typeof moveActorsQuerySchema>;

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
    private readonly settings: SettingsService,
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
    // When the pieces are due, kept on the group so the work list sorts by it. A remake's decision isn't
    // written yet, so its promise counts from now: the decision's moment, in this same transaction.
    const { promised } = await groupPromise(tx, group.id, await workspaceCalendar(tx, this.settings));
    if (promised) {
      await tx.workOrderGroup.update({ where: { id: group.id }, data: { dueOn: new Date(promised) } });
    }
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
   * the caller may work it (Workflow 2 spec, goal 13); `workable=true` keeps only those. Searched, narrowed to
   * a workflow and sorted as `pieceWhere` and `PIECE_SORTS` say (Production lists spec, goal 2).
   */
  async list(auth: TenantAuth, query: WorkOrderQuery): Promise<Page<WorkOrderListItem>> {
    const secret = this.config.get('APP_SECRET');
    const { sort } = query;
    const after = query.cursor ? piecesCursor('pieces', sort, query.cursor, secret) : undefined;
    const mayMove = auth.permissions.has('workflow.move');
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const known = await workContext(tx, auth);
      const { barred } = known;
      const filtered = await pieceWhere(tx, query, auth, known);
      let page: Prisma.WorkOrderWhereInput = {};
      if (after && sort === 'started') page = { id: { gt: after.id } };
      if (after && byDue(sort)) page = duePageWhere(sort, after);
      if (after && sort === 'priority') {
        // First-in-line customers' groups first (Customers 2 spec, goal 17), then in id order. A cursor from
        // before ranks existed carries none: the rank its piece's group has now is taken.
        const rank =
          after.rank ??
          (await tx.workOrder.findUnique({ where: { id: after.id }, select: { group: { select: { queueRank: true } } } }))?.group.queueRank ??
          0;
        page = { OR: afterRanked({}, rank, after.id) };
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
            filtered,
          ],
        },
        orderBy: piecesOrderBy(sort),
        take: query.limit + 1,
        include: pieceInclude,
      });
      const data = rows.slice(0, query.limit);
      const last = data.at(-1);
      const inspect = await toInspect(tx, data);
      const held = await known.holds.reasons(data);
      const moves = await this.moveSummaries(tx, data);
      const groups = await groupSummaries(
        tx,
        data.map((row) => row.groupId),
        auth,
        this.settings,
      );
      return {
        data: data.map((row) => ({
          ...toWorkOrder(row),
          to_inspect: inspect.get(row.id) ?? null,
          may_work: mayMove && row.status === 'active' && !barred.has(row.currentStepId!) && !held.has(row.id),
          held: held.get(row.id) ?? null,
          missing_skill: row.status === 'active' ? (barred.get(row.currentStepId!) ?? null) : null,
          ...(moves.get(row.id) ?? { in_rework: false, last_move: null }),
          group: groups.get(row.groupId)!,
        })),
        next_cursor: rows.length > query.limit && last ? encodeCursor(piecesCursorPayload('pieces', sort, last), secret) : null,
      };
    });
  }

  /**
   * The active pieces `query` picks at each step of its workflow (Production lists spec, goal 3), counted
   * as the list pages them. Steps are the current version's in path order, then keys only an older version
   * has, by their position there; a 404 for a workflow that isn't the workspace's.
   */
  async counts(auth: TenantAuth, query: StepCountsQuery): Promise<StepCountsResponse> {
    const mayMove = auth.permissions.has('workflow.move');
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const current = await tx.workflowVersion.findFirst({
        where: { workflowId: query.workflow_id },
        orderBy: { number: 'desc' },
        select: { steps: { select: { key: true, name: true }, orderBy: { position: 'asc' } } },
      });
      if (!current) throw new NotFoundException('Workflow not found');
      const work = await workContext(tx, auth);
      const { barred } = work;
      const active: Prisma.WorkOrderWhereInput = { AND: [{ status: 'active' }, await pieceWhere(tx, query, auth, work)] };
      // Counted in the database by the step row the pieces are at (one per version); summed by key below.
      const byStep = await tx.workOrder.groupBy({ by: ['currentStepId'], where: active, _count: { _all: true } });
      const heldByStep = await tx.workOrder.groupBy({ by: ['currentStepId'], where: { AND: [active, work.holds.held] }, _count: { _all: true } });
      const heldAt = new Map(heldByStep.map((row) => [row.currentStepId!, row._count._all]));
      const stepRows = await tx.workflowStep.findMany({
        where: { id: { in: byStep.flatMap((row) => (row.currentStepId ? [row.currentStepId] : [])) } },
        select: { id: true, key: true, name: true, position: true },
      });
      const stepOf = new Map(stepRows.map((step) => [step.id, step]));
      // Only a piece once failed for rework can be in rework, so only those pieces' histories are read.
      const reworked = await tx.workOrder.findMany({
        where: { AND: [active, { transitions: { some: { kind: 'fail', outcome: 'rework' } } }] },
        select: { id: true, currentStepId: true },
      });
      const histories = await historiesOf(
        tx,
        reworked.map((piece) => piece.id),
      );

      const steps = new Map(
        current.steps.map((step) => [step.key, { key: step.key, name: step.name, active: 0, in_rework: 0, workable: 0, held: 0 }]),
      );
      // Keys the current version dropped, by where they were on their own version; then by key.
      const older = new Map<string, { name: string; position: number }>();
      for (const step of stepRows) {
        if (steps.has(step.key)) continue;
        const known = older.get(step.key);
        if (!known || step.position < known.position) older.set(step.key, { name: step.name, position: step.position });
      }
      [...older.entries()]
        .sort(([a, first], [b, second]) => first.position - second.position || a.localeCompare(b))
        .forEach(([key, { name }]) => steps.set(key, { key, name, active: 0, in_rework: 0, workable: 0, held: 0 }));
      for (const row of byStep) {
        const at = stepOf.get(row.currentStepId!)!;
        const step = steps.get(at.key)!;
        const held = heldAt.get(at.id) ?? 0;
        step.active += row._count._all;
        step.held += held;
        if (mayMove && !barred.has(at.id)) step.workable += row._count._all - held;
      }
      for (const piece of reworked) {
        if (inRework(histories.get(piece.id) ?? []) !== null) steps.get(stepOf.get(piece.currentStepId!)!.key)!.in_rework += 1;
      }
      return { steps: [...steps.values()] };
    });
  }

  /**
   * The groups with active pieces `query` picks at one step (Production lists spec, goal 4), one row each,
   * paged by group so a page never splits one, in the work list's sorts. A fixed number of reads per page.
   */
  async groupsAtStep(auth: TenantAuth, query: StepGroupsQuery): Promise<Page<StepGroup>> {
    const secret = this.config.get('APP_SECRET');
    const { sort } = query;
    const after = query.cursor ? piecesCursor('groups', sort, query.cursor, secret) : undefined;
    const mayMove = auth.permissions.has('workflow.move');
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const known = await workContext(tx, auth);
      const { barred } = known;
      const here: Prisma.WorkOrderWhereInput = {
        AND: [{ status: 'active', currentStep: { key: query.step_key } }, await pieceWhere(tx, query, auth, known)],
      };
      const rows = await tx.workOrderGroup.findMany({
        where: { AND: [{ workOrders: { some: here } }, after ? groupsPageWhere(sort, after) : {}] },
        orderBy: groupsOrderBy(sort),
        take: query.limit + 1,
        select: { id: true, queueRank: true, dueOn: true },
      });
      const groups = rows.slice(0, query.limit);
      const ids = groups.map((group) => group.id);
      const pieces = await tx.workOrder.findMany({
        where: { AND: [here, { groupId: { in: ids } }] },
        select: { id: true, groupId: true, status: true, currentStepId: true, replacesId: true },
      });
      const histories = await historiesOf(
        tx,
        pieces.map((piece) => piece.id),
      );
      const inspect = await toInspect(tx, pieces);
      const held = await known.holds.reasons(pieces);
      const summaries = await groupSummaries(tx, ids, auth, this.settings);
      const totals = new Map(
        ids.map((id) => [
          id,
          { count: 0, in_rework: 0, workable: 0, to_inspect: 0, held: 0, held_reason: null as HoldReason | null, missing_skill: null as MissingSkill | null },
        ]),
      );
      for (const piece of pieces) {
        const total = totals.get(piece.groupId)!;
        const reason = held.get(piece.id);
        total.count += 1;
        // A group is on one version, so its pieces at the step share one step row and one skill.
        total.missing_skill ??= barred.get(piece.currentStepId!) ?? null;
        if (inRework(histories.get(piece.id) ?? []) !== null) total.in_rework += 1;
        if (reason) {
          total.held += 1;
          // Payment holds the whole group, so it outranks parts.
          if (total.held_reason !== 'waiting_for_payment') total.held_reason = reason;
        } else if (mayMove && !barred.has(piece.currentStepId!)) total.workable += 1;
        if (inspect.get(piece.id) === true) total.to_inspect += 1;
      }
      const last = groups.at(-1);
      return {
        data: groups.map((group) => ({ group: summaries.get(group.id)!, ...totals.get(group.id)! })),
        next_cursor:
          rows.length > query.limit && last
            ? encodeCursor(piecesCursorPayload('groups', sort, { id: last.id, group: { queueRank: last.queueRank, dueOn: last.dueOn } }), secret)
            : null,
      };
    });
  }

  /** The QC history (ADR 0003 §7): every move, newest first, filtered. */
  async transitions(tenantId: string, query: TransitionQuery): Promise<Page<TransitionListItem>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    // One move's rows are in piece order, so its cursor carries the piece's number as `rank`; every other
    // query is newest first, and its cursor carries the row's id alone.
    const byPiece = query.move_id !== undefined;
    let page: Prisma.TransitionWhereInput = {};
    if (after) {
      const { id, rank, sort } = after;
      if (byPiece && sort === PIECE_ORDER_CURSOR && rank !== undefined) {
        page = { OR: [{ workOrder: { number: { gt: rank } } }, { workOrder: { number: rank }, id: { gt: id } }] };
      } else if (!byPiece && sort === undefined) {
        page = { id: { lt: id } };
      } else {
        throw new BadRequestException('Invalid cursor: made for another list');
      }
    }
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.transition.findMany({
        where: { AND: [transitionFilters(query), page] },
        orderBy: byPiece ? [{ workOrder: { number: 'asc' } }, { id: 'asc' }] : { id: 'desc' },
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
        next_cursor:
          rows.length > query.limit && last
            ? encodeCursor(byPiece ? { id: last.id, sort: PIECE_ORDER_CURSOR, rank: last.workOrder.number } : { id: last.id }, secret)
            : null,
      };
    });
  }

  /** Everyone who has made a move, for History's Person filter. */
  moveActors(tenantId: string, query: MoveActorsQuery): Promise<MoveActorsResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => ({ data: await listActors(tx, query) }));
  }

  /**
   * The QC history one move at a time, across every line (Production lists spec, goal 5): each move whole,
   * with every line it touched, its count of pieces there and the partner it counts for there.
   */
  async moveList(auth: TenantAuth, query: MoveListQuery): Promise<Page<MoveListItem>> {
    const secret = this.config.get('APP_SECRET');
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const { moves, next_cursor } = await listMoves(tx, query, auth, secret);
      const summaries = await groupSummaries(
        tx,
        moves.flatMap((rows) => rows.map((row) => row.workOrder.groupId)),
        auth,
        this.settings,
      );
      return {
        data: moves.map((rows) => {
          const { representative, pieces: _pieces, ...facts } = actionFacts(rows);
          const groups = new Map<string, { count: number; partner: { id: string; name: string } | null }>();
          for (const row of rows) {
            const entry = groups.get(row.workOrder.groupId) ?? { count: 0, partner: null };
            entry.count += 1;
            entry.partner ??= row.partner;
            groups.set(row.workOrder.groupId, entry);
          }
          return {
            ...facts,
            override_reason: representative.overrideReason,
            comment: representative.comment,
            actor: { id: representative.actor.id, name: representative.actor.name },
            groups: [...groups.entries()].map(([id, entry]) => ({ group: summaries.get(id)!, ...entry })),
          };
        }),
        next_cursor,
      };
    });
  }

  /** A line's moves, one item per action, newest first (Move history spec). */
  async moves(tenantId: string, groupId: string, query: MoveHistoryQuery): Promise<MoveHistoryResponse> {
    const secret = this.config.get('APP_SECRET');
    return this.prisma.inTenant(tenantId, async (tx) => {
      const { actions, next_cursor, counts } = await listActions(tx, groupId, query, secret);
      return {
        data: actions.map((rows) => {
          const { representative, ...facts } = actionFacts(rows);
          return {
            ...facts,
            override_reason: representative.overrideReason,
            comment: representative.comment,
            actor: { id: representative.actor.id, name: representative.actor.name },
            partner: rows.find((row) => row.partner !== null)?.partner ?? null,
          };
        }),
        next_cursor,
        counts,
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
  group: { select: { quantity: true, queueRank: true, dueOn: true } },
} as const;

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
