import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { GoogleModule } from '../auth/google.module';
import { CatalogModule } from '../catalog/catalog.module';
import { FilesModule } from '../files/files.module';
import { IdentityNotifierModule } from '../identity/identity-notifier';
import { PartnersModule } from '../partners/partners.module';
import { PricingModule } from '../pricing/pricing.module';
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

/** Customer organisations, their people, and the portal they act through (Customers spec). */
@Module({
  imports: [AuditModule, IdentityNotifierModule, GoogleModule, CatalogModule, FilesModule, PricingModule, PartnersModule],
  controllers: [
    CustomersController,
    CustomerSiteController,
    PortalController,
    PortalCatalogController,
    PortalFilesController,
    PortalQuotesController,
  ],
  providers: [CustomersService, CustomerInvitationsService, CustomerSiteService, PortalMembersService, PortalCatalogService],
  exports: [CustomersService, CustomerInvitationsService, CustomerSiteService, PortalCatalogService],
})
export class CustomersModule {}
