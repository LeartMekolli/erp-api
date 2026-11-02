import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../../jobs/handles-job';
import type { JobHandler } from '../../../jobs/handles-job';
import { PriorityService } from './priority.service';

/**
 * Every hour (SCHEDULED_JOBS['customers.priority.refresh']). Computes the priority scores of each workspace
 * not yet computed on its local today; a second run that day finds nothing due.
 */
@Injectable()
@HandlesJob('customers.priority.refresh')
export class PriorityHandler implements JobHandler<Record<string, never>> {
  constructor(private readonly priority: PriorityService) {}

  handle(): Promise<void> {
    return this.priority.refreshEverywhere(new Date());
  }
}
