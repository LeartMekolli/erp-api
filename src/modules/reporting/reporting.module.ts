import { Module } from '@nestjs/common';
import { PartnersModule } from '../partners/partners.module';
import { SettingsModule } from '../settings/settings.module';
import { AttentionService } from './attention.service';
import { ReportsHandler } from './reports.handler';
import { ReportsService } from './reports.service';

/**
 * Read models for the staff dashboard (AI 1 spec): computed by a job, read by staff, never written by clients (D63).
 * Its controller is registered in `AiModule`, which imports this one, since the dashboard also shows the AI briefing.
 */
@Module({
  imports: [PartnersModule, SettingsModule],
  providers: [ReportsService, ReportsHandler, AttentionService],
  exports: [ReportsService, AttentionService],
})
// Not `ReportingModule`: that name is the error reporting in src/common/reporting.
export class ReportsModule {}
