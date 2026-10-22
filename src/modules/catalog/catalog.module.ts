import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';
import { FakeMetalPriceProvider } from './price-feed/fake.provider';
import { METAL_PRICE_PROVIDER } from './price-feed/metal-price-provider';
import type { MetalPriceProvider } from './price-feed/metal-price-provider';
import { MetalsDevProvider } from './price-feed/metals-dev.provider';
import { PriceSnapshotHandler } from './price-feed/price-snapshot.handler';
import { SnapshotsService } from './price-feed/snapshots.service';
import { UnitsService } from './units';
import { UnitsController } from './units.controller';

/** Products, choices, materials and units: what a tenant can make and sell (Catalog spec). */
@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [UnitsController, MaterialsController],
  providers: [
    UnitsService,
    MaterialsService,
    SnapshotsService,
    PriceSnapshotHandler,
    {
      provide: METAL_PRICE_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MetalPriceProvider => {
        const key = config.get('METAL_PRICE_API_KEY');
        // env.ts refuses metalsdev without a key, so the key is set here.
        return config.get('METAL_PRICE_PROVIDER') === 'metalsdev' && key
          ? new MetalsDevProvider(key)
          : new FakeMetalPriceProvider();
      },
    },
  ],
  exports: [UnitsService, MaterialsService],
})
export class CatalogModule {}
