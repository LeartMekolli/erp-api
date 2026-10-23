import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { workflowStepsSchema } from './workflow-config';
import type { WorkflowStepsInput } from './workflow-config';
import {
  categoryWorkflowResponseSchema,
  productWorkflowResponseSchema,
  workflowResponseSchema,
  workflowSummaryResponseSchema,
  workflowVersionResponseSchema,
} from './workflow-response';
import type {
  CategoryWorkflowResponse,
  ProductWorkflowResponse,
  WorkflowResponse,
  WorkflowSummaryResponse,
  WorkflowVersionResponse,
} from './workflow-response';
import { WorkflowsService, assignWorkflowSchema, createWorkflowSchema } from './workflows.service';

const idSchema = z.uuid();
const versionNumberSchema = z.coerce.number().int().min(1);

/** Workflows, their versions, and the categories and products that use them (Workflow/QC spec). */
@Controller('workflow')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @ApiDoc({
    summary: 'Create a workflow; it has no steps until they are first set.',
    description: 'A key already in use is a 409.',
    body: createWorkflowSchema,
    response: workflowSummaryResponseSchema,
    errors: [400],
  })
  @RequirePermission('workflow.write')
  @Post('workflows')
  create(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createWorkflowSchema)) body: z.infer<typeof createWorkflowSchema>,
  ): Promise<WorkflowSummaryResponse> {
    return this.workflows.create(auth, body);
  }

  @ApiDoc({
    summary: 'Every workflow with its current version number, by key.',
    response: z.strictObject({ data: z.array(workflowSummaryResponseSchema) }),
  })
  @RequirePermission('workflow.read')
  @Get('workflows')
  async list(@CurrentTenant() tenantId: string): Promise<{ data: WorkflowSummaryResponse[] }> {
    return { data: await this.workflows.list(tenantId) };
  }

  @ApiDoc({
    summary: 'A workflow and the steps of its current version.',
    response: workflowResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.read')
  @Get('workflows/:id')
  get(@CurrentTenant() tenantId: string, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<WorkflowResponse> {
    return this.workflows.get(tenantId, id);
  }

  @ApiDoc({
    summary: "Replace a workflow's steps, which adds its next version.",
    description:
      'Steps run in the order given. Each has its checklist, the defects allowed there with their default outcome, ' +
      'the steps a failed piece may go back to (itself or earlier ones), what a pass or a fail must bring, ' +
      'an SOP document, an expected duration and the customer view. Pieces already in production keep the ' +
      'version they started on. An unknown or inactive defect, step type or SOP file version is a 404.',
    body: workflowStepsSchema,
    response: workflowVersionResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.write')
  @Put('workflows/:id/steps')
  setSteps(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(workflowStepsSchema)) body: WorkflowStepsInput,
  ): Promise<WorkflowVersionResponse> {
    return this.workflows.setSteps(auth, id, body);
  }

  @ApiDoc({
    summary: 'One version of a workflow, as it was set.',
    response: workflowVersionResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.read')
  @Get('workflows/:id/versions/:number')
  version(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Param('number', new ZodValidationPipe(versionNumberSchema)) number: number,
  ): Promise<WorkflowVersionResponse> {
    return this.workflows.version(tenantId, id, number);
  }

  @ApiDoc({
    summary: "Set the workflow a category's products go through.",
    body: assignWorkflowSchema,
    response: categoryWorkflowResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.write')
  @Put('categories/:id/workflow')
  setCategory(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(assignWorkflowSchema)) body: z.infer<typeof assignWorkflowSchema>,
  ): Promise<CategoryWorkflowResponse> {
    return this.workflows.setCategory(auth, id, body.workflow_id);
  }

  @ApiDoc({
    summary: "The workflow a product goes through: its own, else its category's.",
    response: productWorkflowResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.read')
  @Get('products/:id/workflow')
  productWorkflow(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ): Promise<ProductWorkflowResponse> {
    return this.workflows.productWorkflow(tenantId, id);
  }

  @ApiDoc({
    summary: "Give a product its own workflow in place of its category's.",
    body: assignWorkflowSchema,
    response: productWorkflowResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.write')
  @Put('products/:id/workflow')
  setProduct(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(assignWorkflowSchema)) body: z.infer<typeof assignWorkflowSchema>,
  ): Promise<ProductWorkflowResponse> {
    return this.workflows.setProduct(auth, id, body.workflow_id);
  }

  @ApiDoc({
    summary: "Send a product back to its category's workflow.",
    errors: [400, 404],
  })
  @RequirePermission('workflow.write')
  @Delete('products/:id/workflow')
  @HttpCode(204)
  async clearProduct(@CurrentUser() auth: TenantAuth, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<void> {
    await this.workflows.clearProduct(auth, id);
  }
}
