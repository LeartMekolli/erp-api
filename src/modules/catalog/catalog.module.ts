import { Module } from '@nestjs/common';
import { UnitsService } from './units';
import { UnitsController } from './units.controller';

/** Products, choices, materials and units: what a tenant can make and sell (Catalog spec). */
@Module({
  controllers: [UnitsController],
  providers: [UnitsService],
  exports: [UnitsService],
})
export class CatalogModule {}
