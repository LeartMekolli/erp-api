import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ErrorsModule } from './common/errors/errors.module';
import { LoggingModule } from './common/logging/logging.module';
import { ReportingModule } from './common/reporting/reporting.module';
import { StripCredentialsInterceptor } from './common/serialization/strip-credentials.interceptor';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { JobsModule } from './jobs/jobs.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { IdempotencyModule } from './modules/idempotency/idempotency.module';
import { IdempotencyInterceptor } from './modules/idempotency/idempotency.interceptor';
import { IdentityModule } from './modules/identity/identity.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RolesModule } from './modules/roles/roles.module';
import { SettingsModule } from './modules/settings/settings.module';
import { UsersModule } from './modules/users/users.module';
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
  ],
  // Order matters: the first is outermost, so replayed responses are stripped too.
  providers: [
    { provide: APP_INTERCEPTOR, useClass: StripCredentialsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
