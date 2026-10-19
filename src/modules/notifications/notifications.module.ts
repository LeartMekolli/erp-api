import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { DispatchHandler } from './dispatch.handler';
import { EmailHandler } from './email.handler';
import { FeedController } from './feed.controller';
import { MAILER, SmtpMailer } from './mailer';
import { NotificationSecrets } from './notification-secrets';
import { NotificationsService } from './notifications.service';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/**
 * Spec section 6. Imported by both processes: the API raises notifications
 * and serves templates; the worker runs the dispatch and email jobs.
 */
@Module({
  imports: [AuditModule, SettingsModule],
  controllers: [TemplatesController, FeedController],
  providers: [
    TemplatesService,
    NotificationsService,
    NotificationSecrets,
    DispatchHandler,
    EmailHandler,
    { provide: MAILER, inject: [ConfigService], useFactory: (config: ConfigService) => new SmtpMailer(config) },
  ],
  exports: [TemplatesService, NotificationsService],
})
export class NotificationsModule {}
