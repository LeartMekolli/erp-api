import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PartnersModule } from '../partners/partners.module';
import { SettingsModule } from '../settings/settings.module';
import { AttentionService } from './attention.service';
import { CustomersExport } from './exports/customers.export';
import { ExpireExportsHandler, ExportHandler } from './exports/export.handler';
import { ExportsController } from './exports/exports.controller';
import { ExportsService } from './exports/exports.service';
import { OrdersExport } from './exports/orders.export';
import { PartnersExport } from './exports/partners.export';
import { ReportsHandler } from './reports.handler';
import { ReportsService } from './reports.service';

/**
 * Read models for the staff dashboard (AI 1 spec): computed by a job, read by staff, never written by clients (D63).
 * Its controller is registered in `AiModule`, which imports this one, since the dashboard also shows the AI briefing.
 * Exports of data as CSV and PDF files (Reporting 2 spec), built in the background.
 */
@Module({
  imports: [PartnersModule, SettingsModule, FilesModule, NotificationsModule],
  controllers: [ExportsController],
  providers: [
    ReportsService,
    ReportsHandler,
    AttentionService,
    ExportsService,
    CustomersExport,
    OrdersExport,
    PartnersExport,
    ExportHandler,
    ExpireExportsHandler,
  ],
  exports: [ReportsService, AttentionService, ExportsService],
})
// Not `ReportingModule`: that name is the error reporting in src/common/reporting.
export class ReportsModule {}
