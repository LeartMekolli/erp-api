import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { groupResponseSchema, workOrderDetailResponseSchema, workOrderResponseSchema } from './work-order-response';
import type { GroupResponse, WorkOrderDetailResponse, WorkOrderResponse } from './work-order-response';
import { MAX_PIECES, WorkOrdersService, startGroupSchema, workOrderQuerySchema } from './work-orders.service';
import type { WorkOrderQuery } from './work-orders.service';

const idSchema = z.uuid();

/** Starting pieces and reading where they are (Workflow/QC spec, goals 4 and 9). */
@Controller('workflow')
export class WorkOrdersController {
  constructor(private readonly workOrders: WorkOrdersService) {}

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
    summary: 'One piece, its path, and the instructions for its current step.',
    response: workOrderDetailResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.read')
  @Get('work-orders/:id')
  get(@CurrentTenant() tenantId: string, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<WorkOrderDetailResponse> {
    return this.workOrders.get(tenantId, id);
  }
}
