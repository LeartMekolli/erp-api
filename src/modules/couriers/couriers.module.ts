import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { AuditModule } from '../audit/audit.module';
import { CourierAccountService } from './courier-account.service';
import { COURIER_PROVIDER } from './courier-provider';
import type { CourierProvider } from './courier-provider';
import { CourierAccountController, ShippingRatesController } from './couriers.controller';
import { EasyPostCourierProvider } from './easypost-courier-provider';
import { FakeCourierProvider } from './fake-courier-provider';
import { RatesService } from './rates.service';

/**
 * The courier service (Orders 3 spec, goals 21–25): each workspace's account, live rates, and later
 * labels and tracking. Orders and Claims import it; it imports neither.
 */
@Module({
  imports: [AuditModule],
  controllers: [CourierAccountController, ShippingRatesController],
  providers: [
    CourierAccountService,
    RatesService,
    {
      provide: COURIER_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): CourierProvider =>
        config.get('COURIER_PROVIDER') === 'easypost' ? new EasyPostCourierProvider() : new FakeCourierProvider(),
    },
  ],
  exports: [CourierAccountService, RatesService, COURIER_PROVIDER],
})
export class CouriersModule {}
