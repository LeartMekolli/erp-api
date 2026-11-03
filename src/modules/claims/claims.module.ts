import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CouriersModule } from '../couriers/couriers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PartnersModule } from '../partners/partners.module';
import { PaymentsModule } from '../payments/payments.module';
import { SettingsModule } from '../settings/settings.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ClaimsController, PortalClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';

/**
 * Claims after delivery, and their remakes and refunds (Orders 3 spec, goals 1–7). It sits on top of
 * Orders, Payments, Partners, Workflow and Couriers: it imports them, and none of them imports it.
 */
@Module({
  imports: [AuditModule, CouriersModule, NotificationsModule, PartnersModule, PaymentsModule, SettingsModule, WorkflowModule],
  controllers: [ClaimsController, PortalClaimsController],
  providers: [ClaimsService],
  exports: [ClaimsService],
})
export class ClaimsModule {}
