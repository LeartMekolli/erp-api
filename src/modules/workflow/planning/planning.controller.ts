import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../../identity/auth-context';
import type { TenantAuth } from '../../identity/auth-context';
import { RequirePermission } from '../../identity/route-markers';
import {
  planQuerySchema,
  setCapacitySchema,
  stepCapacitiesResponseSchema,
  stepCapacityResponseSchema,
  stepPlanResponseSchema,
} from './planning-response';
import type { PlanQuery, SetCapacity, StepCapacitiesResponse, StepCapacityResponse, StepPlanResponse } from './planning-response';
import { PlanningService } from './planning.service';

const idParam = new ZodValidationPipe(z.uuid());

/** Daily capacities and the day's plan per in-house step type (Orders 3 spec, goals 16–20). */
@Controller('workflow')
export class PlanningController {
  constructor(private readonly planning: PlanningService) {}

  @ApiDoc({
    summary: 'Every step type with its in-house daily capacity in pieces; null when it has no limit.',
    response: stepCapacitiesResponseSchema,
    errors: [],
  })
  @RequirePermission('workflow.read')
  @Get('capacities')
  capacities(@CurrentTenant() tenantId: string): Promise<StepCapacitiesResponse> {
    return this.planning.capacities(tenantId);
  }

  @ApiDoc({
    summary: 'Set how many pieces a day a step type can take in-house, shared by every workflow using it.',
    description: '`daily_pieces: null` removes the limit: the step type is then planned without one.',
    body: setCapacitySchema,
    response: stepCapacityResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.write')
  @Put('step-types/:id/capacity')
  setCapacity(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(setCapacitySchema)) body: SetCapacity,
  ): Promise<StepCapacityResponse> {
    return this.planning.setCapacity(auth, id, body);
  }

  @ApiDoc({
    summary: "A step type's in-house work for a day, planned back from promised dates within its daily capacity.",
    description:
      'Each list is in priority order: the band in force first, then the earliest promised date, then start order. `late` ' +
      'is filled on today only. Days among the next 14 planned past the capacity are flagged with a suggestion. The plan ' +
      'is computed when read and is a guide: it never moves, blocks or sends out work.',
    query: planQuerySchema,
    response: stepPlanResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.read')
  @Get('plan')
  plan(@CurrentTenant() tenantId: string, @Query(new ZodValidationPipe(planQuerySchema)) query: PlanQuery): Promise<StepPlanResponse> {
    return this.planning.forStepType(tenantId, query);
  }
}
