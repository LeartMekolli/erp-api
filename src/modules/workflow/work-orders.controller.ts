import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { MAX_PHOTOS_PER_MOVE, MAX_PIECES_PER_MOVE, MovesService, moveSchema } from './moves.service';
import type { MoveBody } from './moves.service';
import {
  groupResponseSchema,
  moveResponseSchema,
  transitionListItemSchema,
  workOrderDetailResponseSchema,
  workOrderResponseSchema,
} from './work-order-response';
import type {
  GroupResponse,
  MoveResponse,
  TransitionListItem,
  WorkOrderDetailResponse,
  WorkOrderResponse,
} from './work-order-response';
import { MAX_PIECES, WorkOrdersService, startGroupSchema, transitionQuerySchema, workOrderQuerySchema } from './work-orders.service';
import type { TransitionQuery, WorkOrderQuery } from './work-orders.service';

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
    summary: "A group of pieces: its workflow version, and how many pieces are at each step of its path.",
    response: groupResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.read')
  @Get('groups/:id')
  group(@CurrentTenant() tenantId: string, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<GroupResponse> {
    return this.workOrders.group(tenantId, id);
  }

  @ApiDoc({
    summary: 'Pieces in the order they started, such as the work list of one step.',
    query: workOrderQuerySchema,
    response: pageSchema(workOrderResponseSchema),
    errors: [400],
  })
  @RequirePermission('workflow.read')
  @Get('work-orders')
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(workOrderQuerySchema)) query: WorkOrderQuery,
  ): Promise<Page<WorkOrderResponse>> {
    return this.workOrders.list(tenantId, query);
  }

  @ApiDoc({
    summary: 'Pass, fail or correct pieces at once, each writing a permanent transition with the same answers and photos.',
    description:
      `Pass and fail name \`at_step\`, the step every piece must be at; a piece elsewhere, finished, on another ` +
      `workflow version or already moved by someone else is a 409 naming it, and nothing moves. A pass needs every ` +
      `required answer passing plus the step's pass photos and comment; a fail needs a defect the step records and ` +
      `its fail evidence, and follows the defect's outcome unless \`outcome\` or \`rework_to\` overrides it with ` +
      `\`override_reason\`. A correction puts the pieces at \`to_step\` of their path, reopening finished ones, and ` +
      `needs a comment. Gate problems are a 400 listing each one. At most ${MAX_PIECES_PER_MOVE} pieces and ` +
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
