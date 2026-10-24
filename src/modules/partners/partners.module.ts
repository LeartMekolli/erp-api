import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { GoogleModule } from '../auth/google.module';
import { IdentityNotifierModule } from '../identity/identity-notifier';
import { NotificationsModule } from '../notifications/notifications.module';
import { PricingModule } from '../pricing/pricing.module';
import { SettingsModule } from '../settings/settings.module';
import { EligibilityService } from './eligibility.service';
import { JobsController, PortalJobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { OfferExpiryHandler } from './offer-expiry.handler';
import { PartnerInvitationsService } from './partner-invitations.service';
import { PartnerMembersService } from './partner-members.service';
import { PartnerPortalController } from './partner-portal.controller';
import { PartnerPricesController, PortalPricesController } from './partner-prices.controller';
import { PartnerPricesService } from './partner-prices.service';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';
import { PortalSetupController, SetupController } from './setup.controller';
import { SetupService } from './setup.service';

/** Partner workshops, their people, setup and jobs (Partners spec). */
@Module({
  imports: [AuditModule, IdentityNotifierModule, GoogleModule, NotificationsModule, PricingModule, SettingsModule],
  controllers: [
    // First: its fixed `/partners/eligible` must be matched before `/partners/:id`.
    JobsController,
    PartnersController,
    PartnerPortalController,
    SetupController,
    PortalSetupController,
    PartnerPricesController,
    PortalPricesController,
    PortalJobsController,
  ],
  providers: [
    PartnersService,
    PartnerInvitationsService,
    PartnerMembersService,
    SetupService,
    PartnerPricesService,
    EligibilityService,
    JobsService,
    OfferExpiryHandler,
  ],
  exports: [PartnersService, PartnerInvitationsService, SetupService, EligibilityService, JobsService],
})
export class PartnersModule {}
