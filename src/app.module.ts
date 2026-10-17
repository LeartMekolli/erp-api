import { Module } from '@nestjs/common';
import { ErrorsModule } from './common/errors/errors.module';
import { LoggingModule } from './common/logging/logging.module';
import { ReportingModule } from './common/reporting/reporting.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { SettingsModule } from './modules/settings/settings.module';
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
    HealthModule,
    SettingsModule,
  ],
})
export class AppModule {}
