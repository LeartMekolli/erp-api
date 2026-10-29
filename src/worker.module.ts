import { Module } from '@nestjs/common';
import { LoggingModule } from './common/logging/logging.module';
import { ReportingModule } from './common/reporting/reporting.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { JobsWorkerModule } from './jobs/jobs-worker.module';
import { JobsModule } from './jobs/jobs.module';
import { AiModule } from './modules/ai/ai.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { FilesModule } from './modules/files/files.module';
import { IdempotencyModule } from './modules/idempotency/idempotency.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PartnersModule } from './modules/partners/partners.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ReportsModule } from './modules/reporting/reporting.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';

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
    StorageModule,
    JobsModule,
    JobsWorkerModule,
    IdempotencyModule,
    NotificationsModule,
    FilesModule,
    CatalogModule,
    PartnersModule,
    PaymentsModule,
    AiModule,
    ReportsModule,
  ],
})
export class WorkerModule {}
