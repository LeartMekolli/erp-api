import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { ApiDoc } from '../docs/api-doc';
import { RequirePermission } from '../modules/identity/route-markers';
import { AiSpendService, aiSpendQuerySchema, aiSpendResponseSchema } from './ai-spend.service';
import type { AiSpendResponse } from './ai-spend.service';

@Controller('platform/ai-spend')
export class PlatformAiSpendController {
  constructor(private readonly aiSpend: AiSpendService) {}

  @ApiDoc({
    summary: 'AI spend per UTC day of a month, per workspace, in USD.',
    description:
      "Each figure is rounded to the cent on its own, so the days can differ from the month's total by a few cents. One read per workspace.",
    query: aiSpendQuerySchema,
    response: aiSpendResponseSchema,
    errors: [400],
  })
  @RequirePermission('platform.tenant.read')
  @Get()
  get(@Query(new ZodValidationPipe(aiSpendQuerySchema)) query: z.infer<typeof aiSpendQuerySchema>): Promise<AiSpendResponse> {
    return this.aiSpend.spend(query);
  }
}
