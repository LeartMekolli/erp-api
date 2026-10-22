import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ChainsController } from './chains.controller';
import { ChainsService } from './chains.service';
import { StepTypesController } from './step-types.controller';
import { PricingProfileService, StepTypesService } from './step-types.service';

/** Step types, step prices, adjustments and quotes: what a configuration costs (Pricing spec). */
@Module({
  imports: [AuditModule, CatalogModule],
  controllers: [StepTypesController, ChainsController],
  providers: [StepTypesService, PricingProfileService, ChainsService],
})
export class PricingModule {}
