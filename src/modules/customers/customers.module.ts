import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { GoogleModule } from '../auth/google.module';
import { CatalogModule } from '../catalog/catalog.module';
import { FilesModule } from '../files/files.module';
import { IdentityNotifierModule } from '../identity/identity-notifier';
import { PartnersModule } from '../partners/partners.module';
import { PricingModule } from '../pricing/pricing.module';
import { SettingsModule } from '../settings/settings.module';
import { CustomerAddressesService } from './addresses';
import { CustomerInvitationsService } from './customer-invitations.service';
import { CustomerSiteController } from './customer-site.controller';
import { CustomerSiteService } from './customer-site.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { PortalCatalogController } from './portal-catalog.controller';
import { PortalCatalogService } from './portal-catalog.service';
import { PortalFilesController } from './portal-files.controller';
import { PortalMembersService } from './portal-members.service';
import { PortalQuotesController } from './portal-quotes.controller';
import { PortalController } from './portal.controller';
import { PriorityController } from './priority/priority.controller';
import { PriorityHandler } from './priority/priority.handler';
import { PriorityService } from './priority/priority.service';

/** Customer organisations, their people, the portal they act through, and their priority (Customers specs). */
@Module({
  imports: [AuditModule, IdentityNotifierModule, GoogleModule, CatalogModule, FilesModule, PricingModule, PartnersModule, SettingsModule],
  controllers: [
    CustomersController,
    PriorityController,
    CustomerSiteController,
    PortalController,
    PortalCatalogController,
    PortalFilesController,
    PortalQuotesController,
  ],
  providers: [
    CustomersService,
    CustomerAddressesService,
    CustomerInvitationsService,
    CustomerSiteService,
    PortalMembersService,
    PortalCatalogService,
    PriorityService,
    PriorityHandler,
  ],
  exports: [CustomersService, CustomerAddressesService, CustomerInvitationsService, CustomerSiteService, PortalCatalogService, PriorityService],
})
export class CustomersModule {}
