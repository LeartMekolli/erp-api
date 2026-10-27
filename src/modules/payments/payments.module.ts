import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { SettingsModule } from '../settings/settings.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { FakePaymentProvider } from './fake-payment-provider';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { PaymentAccountController } from './payment-account.controller';
import { PaymentAccountService } from './payment-account.service';
import { PaymentEventHandler } from './payment-event.handler';
import { PaymentEventsService } from './payment-events.service';
import { PAYMENT_PROVIDER } from './payment-provider';
import type { PaymentProvider } from './payment-provider';
import { PaymentTermsController } from './payment-terms.controller';
import { PaymentTermsService } from './payment-terms.service';
import { StripePaymentProvider } from './stripe-payment-provider';
import { UnpaidOrdersHandler } from './unpaid-orders.handler';
import { WebhooksController } from './webhooks.controller';

/**
 * Customers pay, partners are paid, and every movement of money is recorded (Payments spec). Orders
 * never depends on Payments: Payments registers its hooks on OrdersService.
 */
@Module({
  imports: [AuditModule, NotificationsModule, OrdersModule, SettingsModule],
  controllers: [PaymentAccountController, LedgerController, WebhooksController, PaymentTermsController, CheckoutController],
  providers: [
    PaymentAccountService,
    LedgerService,
    PaymentTermsService,
    PaymentEventsService,
    PaymentEventHandler,
    CheckoutService,
    UnpaidOrdersHandler,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PaymentProvider =>
        config.get('PAYMENT_PROVIDER') === 'stripe' ? new StripePaymentProvider() : new FakePaymentProvider(),
    },
  ],
  exports: [PaymentAccountService, LedgerService, PaymentEventsService, PAYMENT_PROVIDER],
})
export class PaymentsModule {}
