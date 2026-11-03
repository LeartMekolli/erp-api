import { Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../../identity/auth-context';
import type { TenantAuth } from '../../identity/auth-context';
import { RequirePermission } from '../../identity/route-markers';
import { jobSummaryResponseSchema } from '../../partners/job-summary-response';
import type { JobSummaryResponse } from '../../partners/job-summary-response';
import { JobSummaryService } from './job-summary.service';

const idParam = new ZodValidationPipe(z.uuid());

/** The AI's brief of a job, as staff see it (Orders 3 spec, goal 15). The workshop sees it on its job. */
@Controller('partners/jobs/:groupId/summary')
export class JobSummaryController {
  constructor(private readonly summaries: JobSummaryService) {}

  @ApiDoc({
    summary: "The AI's latest brief of a job for the workshop holding it; null when none was written.",
    response: jobSummaryResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('partner.read')
  @Get()
  get(@CurrentTenant() tenantId: string, @Param('groupId', idParam) groupId: string): Promise<JobSummaryResponse> {
    return this.summaries.get(tenantId, groupId);
  }

  @ApiDoc({
    summary: "Write the job's brief again, in the background, within the workspace's AI limit.",
    description:
      'Needs `ai.use` too. Answers the new brief as `pending`; read it again for the result. A 409 while one is being ' +
      'written, when no workshop holds the job, when briefs are switched off (`ai.jobSummary`), or when AI is not set up ' +
      "or this month's limit is used.",
    response: jobSummaryResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('partner.assign')
  @Post()
  rewrite(@CurrentUser() auth: TenantAuth, @Param('groupId', idParam) groupId: string): Promise<JobSummaryResponse> {
    return this.summaries.rewrite(auth, groupId);
  }
}
