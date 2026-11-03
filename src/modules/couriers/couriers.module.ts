import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { AuditModule } from '../audit/audit.module';
import { CourierAccountService } from './courier-account.service';
import { CourierEventHandler } from './courier-event.handler';
import { CourierEventsService } from './courier-events.service';
import { COURIER_PROVIDER } from './courier-provider';
import type { CourierProvider } from './courier-provider';
import { CourierAccountController, CourierWebhooksController, ShippingRatesController } from './couriers.controller';
import { EasyPostCourierProvider } from './easypost-courier-provider';
import { FakeCourierProvider } from './fake-courier-provider';
import { RatesService } from './rates.service';
import { ShipmentsService } from './shipments.service';

/**
 * The courier service (Orders 3 spec, goals 21–25): each workspace's account, live rates, labels and
 * tracking. Orders and Claims import it; it imports neither, and tells them of deliveries through
 * `ShipmentsService.onDelivered`.
 */
@Module({
  imports: [AuditModule],
  controllers: [CourierAccountController, ShippingRatesController, CourierWebhooksController],
  providers: [
    CourierAccountService,
    RatesService,
    ShipmentsService,
    CourierEventsService,
    CourierEventHandler,
    {
      provide: COURIER_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): CourierProvider =>
        config.get('COURIER_PROVIDER') === 'easypost' ? new EasyPostCourierProvider() : new FakeCourierProvider(),
    },
  ],
  exports: [CourierAccountService, RatesService, ShipmentsService, COURIER_PROVIDER],
})
export class CouriersModule {}
