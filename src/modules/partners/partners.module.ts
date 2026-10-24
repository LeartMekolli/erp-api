import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { GoogleModule } from '../auth/google.module';
import { IdentityNotifierModule } from '../identity/identity-notifier';
import { PartnerInvitationsService } from './partner-invitations.service';
import { PartnerMembersService } from './partner-members.service';
import { PartnerPortalController } from './partner-portal.controller';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';

/** Partner workshops, their people, setup and jobs (Partners spec). */
@Module({
  imports: [AuditModule, IdentityNotifierModule, GoogleModule],
  controllers: [PartnersController, PartnerPortalController],
  providers: [PartnersService, PartnerInvitationsService, PartnerMembersService],
  exports: [PartnersService, PartnerInvitationsService],
})
export class PartnersModule {}
