import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PricingModule } from '../pricing/pricing.module';
import { SettingsModule } from '../settings/settings.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
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
  imports: [AuditModule, PricingModule, SettingsModule, WorkflowModule],
  controllers: [
    // First: its fixed paths (`/orders/shipping-methods`) must be matched before `/orders/:id`.
    OrderSetupController,
    OrdersController,
  ],
  providers: [
    ShippingMethodsService,
    TaxRatesService,
    OrdersService,
    { provide: TAX_CALCULATOR, useClass: RateTableTaxCalculator },
  ],
  exports: [ShippingMethodsService, OrdersService, TAX_CALCULATOR],
})
export class OrdersModule {}
