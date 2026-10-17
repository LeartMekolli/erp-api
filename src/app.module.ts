import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ErrorsModule } from './common/errors/errors.module';
import { LoggingModule } from './common/logging/logging.module';
import { ReportingModule } from './common/reporting/reporting.module';
import { StripCredentialsInterceptor } from './common/serialization/strip-credentials.interceptor';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { RolesModule } from './modules/roles/roles.module';
import { SettingsModule } from './modules/settings/settings.module';
import { UsersModule } from './modules/users/users.module';
import { PlatformApiModule } from './platform/platform-api.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    ReportingModule,
    ErrorsModule,
    DatabaseModule,
    RedisModule,
    IdentityModule,
    AuthModule,
    HealthModule,
    SettingsModule,
    UsersModule,
    RolesModule,
    PlatformApiModule,
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: StripCredentialsInterceptor }],
})
export class AppModule {}
