import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { moveHistoryQuerySchema } from './move-history';
import type { MoveHistoryQuery } from './move-history';
import { moveHistoryResponseSchema, moveListItemSchema } from './move-history-response';
import type { MoveHistoryResponse, MoveListItem } from './move-history-response';
import { MAX_PHOTOS_PER_MOVE, MAX_PIECES_PER_MOVE, MovesService, moveSchema } from './moves.service';
import type { MoveBody } from './moves.service';
import {
  customerViewResponseSchema,
  groupResponseSchema,
  moveResponseSchema,
  stepCountsResponseSchema,
  stepGroupSchema,
  transitionListItemSchema,
  workOrderDetailResponseSchema,
  workOrderListItemSchema,
} from './work-order-response';
import type {
  CustomerViewResponse,
  GroupResponse,
  MoveResponse,
  StepCountsResponse,
  StepGroup,
  TransitionListItem,
  WorkOrderDetailResponse,
  WorkOrderListItem,
} from './work-order-response';
import {
  MAX_PIECES,
  WorkOrdersService,
  startGroupSchema,
  moveListQuerySchema,
  stepCountsQuerySchema,
  stepGroupsQuerySchema,
  transitionQuerySchema,
  workOrderQuerySchema,
} from './work-orders.service';
import type { MoveListQuery, StepCountsQuery, StepGroupsQuery, TransitionQuery, WorkOrderQuery } from './work-orders.service';

const idSchema = z.uuid();

/** Starting pieces and reading where they are (Workflow/QC spec, goals 4 and 9). */
@Controller('workflow')
export class WorkOrdersController {
  constructor(
    private readonly workOrders: WorkOrdersService,
    private readonly moves: MovesService,
  ) {}

  @ApiDoc({
    summary: "Start production for a saved quote: one work order per piece, at the first step of its product's workflow.",
    description:
      `Each piece's path is the workflow's current version: steps nobody prices always run, priced steps only when ` +
      `the quote priced them. An expired quote, a quote already started, or a workflow that lacks a step the quote ` +
      `priced is a 409; more than ${MAX_PIECES} pieces is a 400.`,
    body: startGroupSchema,
    response: groupResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('workflow.move')
  @Post('groups')
  start(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(startGroupSchema)) body: z.infer<typeof startGroupSchema>,
  ): Promise<GroupResponse> {
    return this.workOrders.startFromQuote(auth, body.quote_id);
  }

  @ApiDoc({
    summary: "A group of pieces: its workflow version, how many pieces are at each step of its path, and each step's checks.",
    response: groupResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.read')
  @Get('groups/:id')
  group(@CurrentTenant() tenantId: string, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<GroupResponse> {
    return this.workOrders.group(tenantId, id);
  }

  @ApiDoc({
    summary: "A line's moves, one item per action, newest first, a page at a time.",
    description: '`only=fails` keeps fails and corrections that put a piece at a step. `counts` covers every page, whatever the filter.',
    query: moveHistoryQuerySchema,
    response: moveHistoryResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.read')
  @Get('groups/:id/moves')
  moveHistory(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Query(new ZodValidationPipe(moveHistoryQuerySchema)) query: MoveHistoryQuery,
  ): Promise<MoveHistoryResponse> {
    return this.workOrders.moves(tenantId, id, query);
  }

  @ApiDoc({
    summary: "A staff preview of exactly what a customer will see of a group: each piece's customer-facing stage and plain flags.",
    description:
      'Hidden steps show the last visible stage before them; `redone` marks a piece being redone after a failed ' +
      'check and `restarted` a replacement. Scrapped and cancelled pieces are left out, and defects, answers, ' +
      'photos and comments never appear. Customers get this view later, with Orders and Plans.',
    response: customerViewResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.read')
  @Get('groups/:id/customer-view')
  customerView(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ): Promise<CustomerViewResponse> {
    return this.workOrders.customerView(tenantId, id);
  }

  @ApiDoc({
    summary: "Pieces in the order to work them, such as the work list of one step: first-in-line customers' first, then as they started.",
    description:
      "A customer whose priority band is first in line has its pieces listed first, higher bands before lower ones. " +
      'Every step is listed to everyone who may read work lists; `may_work` says whether the caller may pass or ' +
      "fail the piece where it is, which at a step that requires a skill needs that skill (the owner always may). " +
      '`held` says why a piece can\'t be passed or failed onward now by anyone: `waiting_for_payment` (its order hasn\'t ' +
      "started), or `waiting_for_parts` (an assembly's piece while a part isn't ready); payment wins when both " +
      'apply. A held piece is never `may_work`. `missing_skill` names the skill the step requires that the caller ' +
      "doesn't hold today, so a row can say whom to ask; null for the owner, at a step requiring none, for a piece " +
      'that isn\'t active, and without `workflow.move`. `workable=true` keeps only `may_work` pieces. `in_rework` says whether an active piece is being redone after a failed ' +
      'check, `last_move` is what last happened to it, and `group` whose the piece is and when it is due. ' +
      '`workflow_id` keeps the pieces of every version of one workflow, so a step key two workflows share can be told ' +
      "apart. `q` finds part of the product's name, any case, with `%` and `_` taken literally; with `order.read`, also " +
      "an order's or a claim's number (`#` optional); with `customer.read`, also part of the customer's name. " +
      "`sort` is `priority` when left out (first-in-line customers' groups first, then as the pieces started); " +
      '`due_on` and `-due_on` order by `group.due_on`, soonest or latest first, with undated pieces last either way and ' +
      'ties as `priority`; `started` is as the pieces started. Every filter applies before paging; a cursor made for ' +
      'another sort is a 400.',
    query: workOrderQuerySchema,
    response: pageSchema(workOrderListItemSchema),
    errors: [400],
  })
  @RequirePermission('workflow.read')
  @Get('work-orders')
  list(
    @CurrentUser() auth: TenantAuth,
    @Query(new ZodValidationPipe(workOrderQuerySchema)) query: WorkOrderQuery,
  ): Promise<Page<WorkOrderListItem>> {
    return this.workOrders.list(auth, query);
  }

  @ApiDoc({
    summary: 'How many active pieces are at each step of one workflow, for the tabs over a work list.',
    description:
      "Every step of the workflow's current version, in path order and zeros included, then any step key only an older " +
      'version still has pieces at. `workflow_id` is required and covers every version; `q` and `workable` filter as on ' +
      '`GET /workflow/work-orders`, so a step\'s `active` is the number of pieces that list pages through for it with ' +
      '`status=active`. `in_rework` and `workable` are the part of `active` being redone, and the part the caller may ' +
      'pass or fail there. `held` is the part nobody can move now (waiting for payment or for parts, as `held` on ' +
      'the list says); it is never part of `workable`.',
    query: stepCountsQuerySchema,
    response: stepCountsResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.read')
  @Get('work-orders/counts')
  counts(
    @CurrentUser() auth: TenantAuth,
    @Query(new ZodValidationPipe(stepCountsQuerySchema)) query: StepCountsQuery,
  ): Promise<StepCountsResponse> {
    return this.workOrders.counts(auth, query);
  }

  @ApiDoc({
    summary: 'The order lines with active pieces at one step, one row each, with how many are there and what they need.',
    description:
      'One row per group (an order line, an assembly part, a remake or a quote) with active pieces at `step_key` of ' +
      "`workflow_id` (every version). `count` is the group's pieces there that the filters pick; `in_rework`, `workable` " +
      'and `to_inspect` are the part of `count` being redone, that the caller may pass or fail, and to inspect in full at ' +
      'a step that samples. `held` is the part nobody can move now, never part of `workable`, and `held_reason` why ' +
      '(`waiting_for_payment` before `waiting_for_parts`; null when none is). `missing_skill` is the skill the step ' +
      "requires that the caller doesn't hold today, as on the list; null when none is missing. " +
      '`q`, `workable` and `sort` work as on `GET /workflow/work-orders`, by group: `started` is as ' +
      'the groups started. Pages are by group, so one is never split; a cursor made for another sort is a 400.',
    query: stepGroupsQuerySchema,
    response: pageSchema(stepGroupSchema),
    errors: [400],
  })
  @RequirePermission('workflow.read')
  @Get('work-orders/groups')
  groupsAtStep(
    @CurrentUser() auth: TenantAuth,
    @Query(new ZodValidationPipe(stepGroupsQuerySchema)) query: StepGroupsQuery,
  ): Promise<Page<StepGroup>> {
    return this.workOrders.groupsAtStep(auth, query);
  }

  @ApiDoc({
    summary: 'Pass, fail or correct pieces at once, each writing a permanent transition with the same answers and photos.',
    description:
      `Pass and fail name \`at_step\`, the step every piece must be at; a piece elsewhere, finished, on another ` +
      `workflow version or already moved by someone else is a 409 naming it, and nothing moves. A pass needs every ` +
      `required answer passing plus the step's pass photos and comment; a fail needs a defect the step records and ` +
      `its fail evidence, and follows the defect's outcome unless \`outcome\` or \`rework_to\` overrides it with ` +
      `\`override_reason\`. A correction puts the pieces at \`to_step\` of their path, reopening finished ones, and ` +
      `needs a comment. At a step that requires a skill, a pass or fail needs that skill, and so does a correction ` +
      `of a piece standing there; without it the move is a 403 naming the skill (the owner always may). ` +
      `At a step that samples, a pass with \`inspected: false\` leaves the pieces uninspected: no answers, no ` +
      `photos, no QC gate. It is a 409 while a drawn piece hasn't passed (\`Waiting for the sample to pass\`) and ` +
      `for a piece that must be inspected in full: a drawn piece, a replacement, one back from rework, or any ` +
      `piece once a fail has ended the sample. ` +
      `Pieces of an assembly can't leave its first step until every part is ready: that move is a ` +
      `409. Gate problems are a 400 listing each one. At most ${MAX_PIECES_PER_MOVE} pieces and ` +
      `${MAX_PHOTOS_PER_MOVE} photos per move.`,
    body: moveSchema,
    response: moveResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('workflow.move')
  @Post('moves')
  @HttpCode(200)
  move(@CurrentUser() auth: TenantAuth, @Body(new ZodValidationPipe(moveSchema)) body: MoveBody): Promise<MoveResponse> {
    return this.moves.move(auth, body);
  }

  @ApiDoc({
    summary: 'The QC history one move at a time, newest first: each move whole, with every line it touched.',
    description:
      'Takes the filters of `GET /workflow/transitions`, plus `kind`, `workflow_id` (every version) and `q`, which ' +
      'matches as on `GET /workflow/work-orders`. A filter picks the moves with a row it matches, and each move is then ' +
      'listed whole: `groups` names every line the move touched, with how many of its pieces it moved and the partner ' +
      "it counts for there, even a line the filter didn't match. Pages are by move, so one is never split.",
    query: moveListQuerySchema,
    response: pageSchema(moveListItemSchema),
    errors: [400],
  })
  @RequirePermission('workflow.read')
  @Get('moves')
  moveList(
    @CurrentUser() auth: TenantAuth,
    @Query(new ZodValidationPipe(moveListQuerySchema)) query: MoveListQuery,
  ): Promise<Page<MoveListItem>> {
    return this.workOrders.moveList(auth, query);
  }

  @ApiDoc({
    summary: 'The QC history: every move of every piece, newest first, filtered by piece, group, step, defect, design file, actor or time.',
    description:
      '`step_key` matches the step the move was made at. `from` is inclusive and `to` exclusive. `move_id` keeps the ' +
      'rows one move wrote.',
    query: transitionQuerySchema,
    response: pageSchema(transitionListItemSchema),
    errors: [400],
  })
  @RequirePermission('workflow.read')
  @Get('transitions')
  transitions(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(transitionQuerySchema)) query: TransitionQuery,
  ): Promise<Page<TransitionListItem>> {
    return this.workOrders.transitions(tenantId, query);
  }

  @ApiDoc({
    summary: 'One piece, its path, the instructions for its current step, and every move it has made.',
    response: workOrderDetailResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.read')
  @Get('work-orders/:id')
  get(@CurrentTenant() tenantId: string, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<WorkOrderDetailResponse> {
    return this.workOrders.get(tenantId, id);
  }
}
