import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { IdentityNotifierModule } from '../identity/identity-notifier';
import { CustomerInvitationsService } from './customer-invitations.service';
import { CustomerSiteController } from './customer-site.controller';
import { CustomerSiteService } from './customer-site.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

/** Customer organisations, their people, and the portal they act through (Customers spec). */
@Module({
  imports: [AuditModule, IdentityNotifierModule],
  controllers: [CustomersController, CustomerSiteController],
  providers: [CustomersService, CustomerInvitationsService, CustomerSiteService],
  exports: [CustomersService, CustomerInvitationsService, CustomerSiteService],
})
export class CustomersModule {}
