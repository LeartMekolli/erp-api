import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { AuditModule } from '../audit/audit.module';
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
import { WebhooksController } from './webhooks.controller';

/** Customers pay, partners are paid, and every movement of money is recorded (Payments spec). */
@Module({
  imports: [AuditModule],
  controllers: [PaymentAccountController, LedgerController, WebhooksController, PaymentTermsController],
  providers: [
    PaymentAccountService,
    LedgerService,
    PaymentTermsService,
    PaymentEventsService,
    PaymentEventHandler,
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
