import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { AskService } from './ask.service';
import { aiRunListQuerySchema, aiRunListResponseSchema, aiRunResponseSchema, askResponseSchema, askSchema } from './run-response';
import type { AiRunListItem, AiRunResponse, AskBody } from './run-response';

const idParam = new ZodValidationPipe(z.uuid());

/** Cmd+K's ask and the AI run log (AI 1 spec, goal 11, and Settled after the builder check). */
@Controller('ai')
export class RunsController {
  constructor(private readonly ask: AskService) {}

  @ApiDoc({
    summary: 'Ask the AI a question about the workspace; it is answered in the background.',
    description:
      'Answers 202 with the run id; poll `GET /ai/runs/{id}` for the answer. The AI reads only what you may see. ' +
      'A workspace without an AI limit, or whose limit this month is used, is a 409 and nothing is queued.',
    body: askSchema,
    response: askResponseSchema,
    errors: [400, 409],
  })
  @RequirePermission('ai.use')
  @Post('ask')
  @HttpCode(202)
  async askQuestion(@CurrentUser() auth: TenantAuth, @Body(new ZodValidationPipe(askSchema)) body: AskBody): Promise<{ id: string }> {
    const { runId } = await this.ask.ask(auth, body.question);
    return { id: runId };
  }

  @ApiDoc({
    summary: "The workspace's AI runs, newest first: who, which model, tokens, cost and status.",
    description: 'Never what a run asked or answered. Pass `next_cursor` back as `cursor` for the next page.',
    query: aiRunListQuerySchema,
    response: aiRunListResponseSchema,
    errors: [400],
  })
  @RequirePermission('settings.read')
  @Get('runs')
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(aiRunListQuerySchema)) query: z.infer<typeof aiRunListQuerySchema>,
  ): Promise<Page<AiRunListItem>> {
    return this.ask.list(tenantId, query);
  }

  @ApiDoc({
    summary: 'One of your own AI runs, with its answer once it is done.',
    description:
      'Each cited record and proposed action comes with its label as it reads now; one you may no longer see is ' +
      "left out. Someone else's run is a 404.",
    response: aiRunResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('ai.use')
  @Get('runs/:id')
  run(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<AiRunResponse> {
    return this.ask.run(auth, id);
  }
}
