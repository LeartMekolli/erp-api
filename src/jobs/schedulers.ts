import { JobsService } from './jobs.service';
import { FAILED_JOB_RETENTION_SECONDS } from './registry';
import type { JobRegistry } from './registry';

/**
 * Declares every scheduled job (J3). A scheduler is keyed by its name, so a
 * second worker instance upserts the same entry instead of adding a second
 * schedule. One attempt per run: the next run is never far away.
 */
export async function upsertSchedulers(jobs: JobsService, scheduled: JobRegistry['scheduled']): Promise<void> {
  for (const [name, definition] of Object.entries(scheduled)) {
    await jobs.queue(definition.queue).upsertJobScheduler(name, definition.schedule, {
      name,
      data: {},
      opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: FAILED_JOB_RETENTION_SECONDS } },
    });
  }
}
