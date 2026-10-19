import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/** Spec section 6. Raising and dispatch join this module in the next task. */
@Module({
  imports: [AuditModule],
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class NotificationsModule {}
