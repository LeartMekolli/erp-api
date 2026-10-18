import { Module } from '@nestjs/common';
import { IdempotencyCleanupHandler } from './idempotency-cleanup.handler';
import { IdempotencyService } from './idempotency.service';

/**
 * Imported by both processes: the API registers the interceptor (in
 * AppModule, after credential stripping), the worker runs the cleanup.
 */
@Module({
  providers: [IdempotencyService, IdempotencyCleanupHandler],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
