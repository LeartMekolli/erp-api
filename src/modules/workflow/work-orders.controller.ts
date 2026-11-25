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
import { moveHistoryResponseSchema } from './move-history-response';
import type { MoveHistoryResponse } from './move-history-response';
import { MAX_PHOTOS_PER_MOVE, MAX_PIECES_PER_MOVE, MovesService, moveSchema } from './moves.service';
import type { MoveBody } from './moves.service';
import {
  customerViewResponseSchema,
  groupResponseSchema,
  moveResponseSchema,
  stepCountsResponseSchema,
  transitionListItemSchema,
  workOrderDetailResponseSchema,
  workOrderListItemSchema,
} from './work-order-response';
import type {
  CustomerViewResponse,
  GroupResponse,
  MoveResponse,
  StepCountsResponse,
  TransitionListItem,
  WorkOrderDetailResponse,
  WorkOrderListItem,
} from './work-order-response';
import {
  MAX_PIECES,
  WorkOrdersService,
  startGroupSchema,
  stepCountsQuerySchema,
  transitionQuerySchema,
  workOrderQuerySchema,
} from './work-orders.service';
import type { StepCountsQuery, TransitionQuery, WorkOrderQuery } from './work-orders.service';

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
      '`workable=true` keeps only those pieces. `in_rework` says whether an active piece is being redone after a failed ' +
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
      'pass or fail there.',
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
    summary: 'The QC history: every move of every piece, newest first, filtered by piece, group, step, defect, design file, actor or time.',
    description: '`step_key` matches the step the move was made at. `from` is inclusive and `to` exclusive.',
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
