import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CheckController } from './check.controller';
import { CheckService } from './check.service';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';
import { OptionsController } from './options.controller';
import { OptionsService } from './options.service';
import { FakeMetalPriceProvider } from './price-feed/fake.provider';
import { METAL_PRICE_PROVIDER } from './price-feed/metal-price-provider';
import type { MetalPriceProvider } from './price-feed/metal-price-provider';
import { MetalsDevProvider } from './price-feed/metals-dev.provider';
import { PriceSnapshotHandler } from './price-feed/price-snapshot.handler';
import { SnapshotsService } from './price-feed/snapshots.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { UnitsService } from './units';
import { UnitsController } from './units.controller';

/** Products, choices, materials and units: what a tenant can make and sell (Catalog spec). */
@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [UnitsController, MaterialsController, OptionsController, ProductsController, CheckController],
  providers: [
    UnitsService,
    MaterialsService,
    OptionsService,
    ProductsService,
    CheckService,
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
  exports: [UnitsService, MaterialsService, OptionsService, ProductsService],
})
export class CatalogModule {}
