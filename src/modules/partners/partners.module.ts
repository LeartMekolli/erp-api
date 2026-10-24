import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { GoogleModule } from '../auth/google.module';
import { IdentityNotifierModule } from '../identity/identity-notifier';
import { NotificationsModule } from '../notifications/notifications.module';
import { PartnerInvitationsService } from './partner-invitations.service';
import { PartnerMembersService } from './partner-members.service';
import { PartnerPortalController } from './partner-portal.controller';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';
import { PortalSetupController, SetupController } from './setup.controller';
import { SetupService } from './setup.service';

/** Partner workshops, their people, setup and jobs (Partners spec). */
@Module({
  imports: [AuditModule, IdentityNotifierModule, GoogleModule, NotificationsModule],
  controllers: [PartnersController, PartnerPortalController, SetupController, PortalSetupController],
  providers: [PartnersService, PartnerInvitationsService, PartnerMembersService, SetupService],
  exports: [PartnersService, PartnerInvitationsService, SetupService],
})
export class PartnersModule {}
