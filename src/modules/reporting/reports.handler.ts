import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { ReportsService } from './reports.service';

/**
 * Every 15 minutes (SCHEDULED_JOBS['reports.refresh']). Recomputes every workspace's dashboard numbers
 * for this week and last; a second run replaces the rows with the numbers as they are now.
 */
@Injectable()
@HandlesJob('reports.refresh')
export class ReportsHandler implements JobHandler<Record<string, never>> {
  constructor(private readonly reports: ReportsService) {}

  handle(): Promise<void> {
    return this.reports.refreshEverywhere(new Date());
  }
}
