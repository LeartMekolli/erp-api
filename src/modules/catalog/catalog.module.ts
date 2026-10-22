import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';
import { SnapshotsService } from './price-feed/snapshots.service';
import { UnitsService } from './units';
import { UnitsController } from './units.controller';

/** Products, choices, materials and units: what a tenant can make and sell (Catalog spec). */
@Module({
  imports: [AuditModule],
  controllers: [UnitsController, MaterialsController],
  providers: [UnitsService, MaterialsService, SnapshotsService],
  exports: [UnitsService, MaterialsService],
})
export class CatalogModule {}
