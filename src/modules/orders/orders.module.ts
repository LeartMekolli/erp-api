import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OrderSetupController } from './shipping-methods.controller';
import { ShippingMethodsService } from './shipping-methods.service';
import { RateTableTaxCalculator, TAX_CALCULATOR } from './tax';
import { TaxRatesService } from './tax-rates.service';

/**
 * Orders: what customers buy, made to order and shipped (Orders spec). The setup controller comes
 * first, so its fixed paths (`/orders/shipping-methods`) are matched before any `/orders/:id`.
 */
@Module({
  imports: [AuditModule],
  controllers: [OrderSetupController],
  providers: [ShippingMethodsService, TaxRatesService, { provide: TAX_CALCULATOR, useClass: RateTableTaxCalculator }],
  exports: [ShippingMethodsService, TAX_CALCULATOR],
})
export class OrdersModule {}
