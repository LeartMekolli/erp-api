import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ErrorsModule } from './common/errors/errors.module';
import { ReportingModule } from './common/reporting/reporting.module';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [ConfigModule, ReportingModule, ErrorsModule, HealthModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
