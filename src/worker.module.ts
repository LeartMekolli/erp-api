import { Module } from '@nestjs/common';
import { LoggingModule } from './common/logging/logging.module';
import { ReportingModule } from './common/reporting/reporting.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { JobsWorkerModule } from './jobs/jobs-worker.module';
import { JobsModule } from './jobs/jobs.module';
import { IdempotencyModule } from './modules/idempotency/idempotency.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RedisModule } from './redis/redis.module';

/**
 * The worker process (F11): the same code as the API, no HTTP. Modules that
 * declare job handlers are added here as they arrive.
 */
@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    ReportingModule,
    DatabaseModule,
    RedisModule,
    JobsModule,
    JobsWorkerModule,
    IdempotencyModule,
    NotificationsModule,
  ],
})
export class WorkerModule {}
