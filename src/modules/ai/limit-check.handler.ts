import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { RunsService } from './runs.service';

/**
 * After a platform admin sets a workspace's AI limit (JOBS['ai.limit.check']): staff are told of the 80 %
 * and 100 % levels the month's spend now crosses, once per month and level, as when a run finishes.
 */
@Injectable()
@HandlesJob('ai.limit.check')
export class LimitCheckHandler implements JobHandler<{ tenantId: string; at: string }> {
  constructor(private readonly runs: RunsService) {}

  handle(payload: { tenantId: string; at: string }): Promise<void> {
    return this.runs.checkNotices(payload.tenantId);
  }
}
