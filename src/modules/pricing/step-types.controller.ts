import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { pricingProfileResponseSchema, stepTypeResponseSchema } from './pricing-response';
import type { PricingProfileResponse, StepTypeResponse } from './pricing-response';
import {
  PricingProfileService,
  StepTypesService,
  createStepTypeSchema,
  pricingProfileSchema,
  updateStepTypeSchema,
} from './step-types.service';

const idSchema = z.uuid();

/** Step types and the workspace's pricing profile (Pricing spec). */
@Controller('pricing')
export class StepTypesController {
  constructor(
    private readonly stepTypes: StepTypesService,
    private readonly profile: PricingProfileService,
  ) {}

  @ApiDoc({
    summary: 'Create a step type, a production operation the workspace prices.',
    description:
      '`position` orders the steps of a chain; `summary_group` places the step in the customer summary. ' +
      'A key already in use is a 409.',
    body: createStepTypeSchema,
    response: stepTypeResponseSchema,
    errors: [400],
  })
  @RequirePermission('pricing.write')
  @Post('step-types')
  create(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createStepTypeSchema)) body: z.infer<typeof createStepTypeSchema>,
  ): Promise<StepTypeResponse> {
    return this.stepTypes.create(auth, body);
  }

  @ApiDoc({
    summary: 'Every step type, in chain order.',
    response: z.strictObject({ data: z.array(stepTypeResponseSchema) }),
  })
  @RequirePermission('pricing.read')
  @Get('step-types')
  async list(@CurrentTenant() tenantId: string): Promise<{ data: StepTypeResponse[] }> {
    return { data: await this.stepTypes.list(tenantId) };
  }

  @ApiDoc({
    summary: "Change a step type's name, position or summary group.",
    body: updateStepTypeSchema,
    response: stepTypeResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('pricing.write')
  @Patch('step-types/:id')
  update(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateStepTypeSchema)) body: z.infer<typeof updateStepTypeSchema>,
  ): Promise<StepTypeResponse> {
    return this.stepTypes.update(auth, id, body);
  }

  @ApiDoc({
    summary: "The workspace's margin, overhead per piece and how long quotes hold.",
    description: 'Before it is first set: margin 0, overhead 0, 7 days.',
    response: pricingProfileResponseSchema,
  })
  @RequirePermission('pricing.read')
  @Get('profile')
  getProfile(@CurrentTenant() tenantId: string): Promise<PricingProfileResponse> {
    return this.profile.read(tenantId);
  }

  @ApiDoc({
    summary: "Set the workspace's margin, overhead per piece and quote validity.",
    description: 'Recorded in the audit log with the old and new values. Quotes already given keep their price.',
    body: pricingProfileSchema,
    response: pricingProfileResponseSchema,
    errors: [400],
  })
  @RequirePermission('pricing.write')
  @Put('profile')
  setProfile(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(pricingProfileSchema)) body: z.infer<typeof pricingProfileSchema>,
  ): Promise<PricingProfileResponse> {
    return this.profile.set(auth, body);
  }
}
