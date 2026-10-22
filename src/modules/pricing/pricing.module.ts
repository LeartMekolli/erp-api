import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CatalogModule } from '../catalog/catalog.module';
import { StepTypesController } from './step-types.controller';
import { PricingProfileService, StepTypesService } from './step-types.service';

/** Step types, step prices, adjustments and quotes: what a configuration costs (Pricing spec). */
@Module({
  imports: [AuditModule, CatalogModule],
  controllers: [StepTypesController],
  providers: [StepTypesService, PricingProfileService],
})
export class PricingModule {}
