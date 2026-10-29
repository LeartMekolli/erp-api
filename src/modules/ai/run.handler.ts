import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { RunsService } from './runs.service';

/**
 * Runs one queued AI call (JOBS['ai.run']) and writes its result. A retry of a run already finished
 * does nothing; after the last attempt fails, the run gets a failed result at no cost.
 */
@Injectable()
@HandlesJob('ai.run')
export class RunHandler implements JobHandler<{ tenantId: string; runId: string }> {
  constructor(private readonly runs: RunsService) {}

  handle(payload: { tenantId: string; runId: string }): Promise<void> {
    return this.runs.execute(payload.tenantId, payload.runId);
  }

  onDeadLetter(payload: { tenantId: string; runId: string }, error: Error): Promise<void> {
    return this.runs.fail(payload.tenantId, payload.runId, error.message);
  }
}
