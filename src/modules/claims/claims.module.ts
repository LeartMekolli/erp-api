import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { ClaimsController, PortalClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';

/**
 * Claims after delivery, and their remakes and refunds (Orders 3 spec, goals 1–7). It sits on top of
 * Orders, Payments, Partners and Workflow: it imports them, and none of them imports it.
 */
@Module({
  imports: [AuditModule, NotificationsModule, SettingsModule],
  controllers: [ClaimsController, PortalClaimsController],
  providers: [ClaimsService],
  exports: [ClaimsService],
})
export class ClaimsModule {}
