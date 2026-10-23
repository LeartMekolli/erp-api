import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { GoogleModule } from '../auth/google.module';
import { IdentityNotifierModule } from '../identity/identity-notifier';
import { CustomerInvitationsService } from './customer-invitations.service';
import { CustomerSiteController } from './customer-site.controller';
import { CustomerSiteService } from './customer-site.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { PortalMembersService } from './portal-members.service';
import { PortalController } from './portal.controller';

/** Customer organisations, their people, and the portal they act through (Customers spec). */
@Module({
  imports: [AuditModule, IdentityNotifierModule, GoogleModule],
  controllers: [CustomersController, CustomerSiteController, PortalController],
  providers: [CustomersService, CustomerInvitationsService, CustomerSiteService, PortalMembersService],
  exports: [CustomersService, CustomerInvitationsService, CustomerSiteService],
})
export class CustomersModule {}
