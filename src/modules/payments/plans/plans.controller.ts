import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../../identity/auth-context';
import type { TenantAuth } from '../../identity/auth-context';
import { RequirePermission } from '../../identity/route-markers';
import { createPlanSchema, planListResponseSchema, planResponseSchema, updatePlanSchema } from './plan-response';
import type { CreatePlan, PlanListResponse, PlanResponse, UpdatePlan } from './plan-response';
import { PlansService } from './plans.service';

const idParam = new ZodValidationPipe(z.uuid());

/** The workspace's plans (Payments 2 spec, goals 1–3), as staff manage them. */
@Controller('payments/plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @ApiDoc({
    summary: 'Every plan of the workspace, the free default plan included, in display order.',
    response: planListResponseSchema,
  })
  @RequirePermission('payment.read')
  @Get()
  list(@CurrentTenant() tenantId: string): Promise<PlanListResponse> {
    return this.plans.list(tenantId);
  }

  @ApiDoc({
    summary: 'Create a paid plan with a monthly and a yearly price, published to Stripe when the workspace has keys.',
    description:
      "Every plan offers the workspace's default delivery speed; `speeds` lists the others it offers, each at the speed's own surcharge (null) or at the plan's.",
    body: createPlanSchema,
    response: planResponseSchema,
    errors: [400, 409],
  })
  @RequirePermission('plan.write')
  @Post()
  create(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createPlanSchema)) body: CreatePlan,
  ): Promise<PlanResponse> {
    return this.plans.create(auth, body);
  }

  @ApiDoc({
    summary: "Change a plan; every edit reaches its subscribers at once, except a price, which only new subscribers pay.",
    body: updatePlanSchema,
    response: planResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('plan.write')
  @Patch(':id')
  update(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updatePlanSchema)) body: UpdatePlan,
  ): Promise<PlanResponse> {
    return this.plans.update(auth, id, body);
  }

  @ApiDoc({
    summary: 'Stop selling a plan; its subscribers keep it.',
    response: planResponseSchema,
    errors: [404, 409],
  })
  @RequirePermission('plan.write')
  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<PlanResponse> {
    return this.plans.archive(auth, id);
  }

  @ApiDoc({
    summary: 'Create at Stripe every plan product and price not there yet.',
    description: 'Does nothing while the workspace has no Stripe keys.',
  })
  @RequirePermission('plan.write')
  @Post('sync')
  @HttpCode(204)
  async sync(@CurrentTenant() tenantId: string): Promise<void> {
    await this.plans.publish(tenantId);
  }
}
