import { Injectable, Logger } from '@nestjs/common';
import { HandlesJob, JobHandler } from '../../jobs/handles-job';
import { IdempotencyService } from './idempotency.service';

/** Retention for idempotency keys (ADR 0005, consequences). */
export const IDEMPOTENCY_RETENTION_DAYS = 30;

/** Daily at 03:00 UTC (SCHEDULED_JOBS['idempotency.cleanup']). */
@Injectable()
@HandlesJob('idempotency.cleanup')
export class IdempotencyCleanupHandler implements JobHandler<Record<string, never>> {
  private readonly logger = new Logger(IdempotencyCleanupHandler.name);

  constructor(private readonly store: IdempotencyService) {}

  async handle(): Promise<void> {
    const deleted = await this.store.deleteOlderThan(IDEMPOTENCY_RETENTION_DAYS);
    this.logger.log(`Deleted ${deleted} idempotency keys older than ${IDEMPOTENCY_RETENTION_DAYS} days`);
  }
}
