import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../../jobs/handles-job';
import type { JobHandler } from '../../../jobs/handles-job';
import { JobSummaryService } from './job-summary.service';

/**
 * Every minute (SCHEDULED_JOBS['ai.job_summaries']). Queues a summary for each job a workshop newly
 * holds; a second run finds the summary already there.
 */
@Injectable()
@HandlesJob('ai.job_summaries')
export class JobSummaryHandler implements JobHandler<Record<string, never>> {
  constructor(private readonly summaries: JobSummaryService) {}

  async handle(): Promise<void> {
    await this.summaries.queueDueEverywhere(new Date());
  }
}
