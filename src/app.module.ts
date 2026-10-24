import { DynamicModule, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ErrorsModule } from './common/errors/errors.module';
import { LoggingModule } from './common/logging/logging.module';
import { ReportingModule } from './common/reporting/reporting.module';
import { StripCredentialsInterceptor } from './common/serialization/strip-credentials.interceptor';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { JobsWorkerModule } from './jobs/jobs-worker.module';
import { JobsModule } from './jobs/jobs.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CustomersModule } from './modules/customers/customers.module';
import { FilesModule } from './modules/files/files.module';
import { HealthModule } from './modules/health/health.module';
import { IdempotencyModule } from './modules/idempotency/idempotency.module';
import { IdempotencyInterceptor } from './modules/idempotency/idempotency.interceptor';
import { IdentityModule } from './modules/identity/identity.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PartnersModule } from './modules/partners/partners.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { RolesModule } from './modules/roles/roles.module';
import { SettingsModule } from './modules/settings/settings.module';
import { UsersModule } from './modules/users/users.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { PlatformApiModule } from './platform/platform-api.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    ReportingModule,
    ErrorsModule,
    DatabaseModule,
    RedisModule,
    StorageModule,
    JobsModule,
    IdentityModule,
    AuthModule,
    HealthModule,
    SettingsModule,
    UsersModule,
    RolesModule,
    PlatformApiModule,
    IdempotencyModule,
    NotificationsModule,
    FilesModule,
    CatalogModule,
    PricingModule,
    CustomersModule,
    WorkflowModule,
    PartnersModule,
  ],
  // Order matters: the first is outermost, so replayed responses are stripped too.
  providers: [
    { provide: APP_INTERCEPTOR, useClass: StripCredentialsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {
  /**
   * The API alone enqueues. With `withWorker` it also consumes (WORKER_IN_PROCESS):
   * the same consumer module `worker.ts` runs, added last so that on shutdown it
   * is destroyed before the database and Redis modules and waits for active jobs.
   */
  static register(options: { withWorker: boolean }): DynamicModule {
    return { module: AppModule, imports: options.withWorker ? [JobsWorkerModule] : [] };
  }
}
