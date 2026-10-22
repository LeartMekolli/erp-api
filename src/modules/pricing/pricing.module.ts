import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CatalogModule } from '../catalog/catalog.module';
import { AdjustmentsController } from './adjustments.controller';
import { AdjustmentsService } from './adjustments.service';
import { ChainsController } from './chains.controller';
import { ChainsService } from './chains.service';
import { StepPricesController } from './step-prices.controller';
import { StepPricesService } from './step-prices.service';
import { StepTypesController } from './step-types.controller';
import { PricingProfileService, StepTypesService } from './step-types.service';

/** Step types, step prices, adjustments and quotes: what a configuration costs (Pricing spec). */
@Module({
  imports: [AuditModule, CatalogModule],
  controllers: [StepTypesController, ChainsController, StepPricesController, AdjustmentsController],
  providers: [StepTypesService, PricingProfileService, ChainsService, StepPricesService, AdjustmentsService],
})
export class PricingModule {}
