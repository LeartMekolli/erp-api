import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CouriersModule } from '../couriers/couriers.module';
import { FilesModule } from '../files/files.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PricingModule } from '../pricing/pricing.module';
import { SettingsModule } from '../settings/settings.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { CommentsService } from './comments.service';
import { OrderCommentsController, PortalOrderCommentsController } from './comments.controller';
import { OrderStatesHandler } from './order-states.handler';
import { OrderStatesService } from './order-states.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PortalOrdersController } from './portal-orders.controller';
import { ProgressEmailsHandler, ProgressEmailsSweepHandler } from './progress-emails.handler';
import { ProgressEmailsService } from './progress-emails.service';
import { OrderSetupController } from './shipping-methods.controller';
import { ShippingMethodsService } from './shipping-methods.service';
import { RateTableTaxCalculator, TAX_CALCULATOR } from './tax';
import { TaxRatesService } from './tax-rates.service';

/**
 * Orders: what customers buy, made to order and shipped (Orders spec). A picked workshop's job is
 * created by the Partners start hook on Workflow's WorkOrdersService, so Orders never depends on
 * Partners.
 */
@Module({
  imports: [AuditModule, CouriersModule, FilesModule, NotificationsModule, PricingModule, SettingsModule, WorkflowModule],
  controllers: [
    // First: its fixed paths (`/orders/shipping-methods`) must be matched before `/orders/:id`.
    OrderSetupController,
    OrdersController,
    OrderCommentsController,
    PortalOrdersController,
    PortalOrderCommentsController,
  ],
  providers: [
    ShippingMethodsService,
    TaxRatesService,
    OrdersService,
    OrderStatesService,
    OrderStatesHandler,
    CommentsService,
    ProgressEmailsService,
    ProgressEmailsHandler,
    ProgressEmailsSweepHandler,
    { provide: TAX_CALCULATOR, useClass: RateTableTaxCalculator },
  ],
  // CommentsService is also the partner's way into an order's comments (PartnersModule), so Orders never depends on Partners.
  exports: [ShippingMethodsService, OrdersService, OrderStatesService, CommentsService, TAX_CALCULATOR],
})
export class OrdersModule {}
