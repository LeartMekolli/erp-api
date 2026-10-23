import { Module } from '@nestjs/common';
import { RateLimitModule } from '../../common/rate-limit/rate-limiter';
import { AuditModule } from '../audit/audit.module';
import { CustomersModule } from '../customers/customers.module';
import { IdentityNotifierModule } from '../identity/identity-notifier';
import { NotificationsModule } from '../notifications/notifications.module';
import { IdentityModule } from '../identity/identity.module';
import { AuthController } from './auth.controller';
import { InvitationAcceptService } from './invitation-accept.service';
import { PasswordResetService } from './password-reset.service';
import { SessionService } from './session.service';

@Module({
  imports: [IdentityModule, IdentityNotifierModule, NotificationsModule, AuditModule, RateLimitModule, CustomersModule],
  controllers: [AuthController],
  providers: [SessionService, InvitationAcceptService, PasswordResetService],
})
export class AuthModule {}
