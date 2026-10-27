import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { AuditModule } from '../audit/audit.module';
import { FakePaymentProvider } from './fake-payment-provider';
import { PaymentAccountController } from './payment-account.controller';
import { PaymentAccountService } from './payment-account.service';
import { PAYMENT_PROVIDER } from './payment-provider';
import type { PaymentProvider } from './payment-provider';
import { StripePaymentProvider } from './stripe-payment-provider';

/** Customers pay, partners are paid, and every movement of money is recorded (Payments spec). */
@Module({
  imports: [AuditModule],
  controllers: [PaymentAccountController],
  providers: [
    PaymentAccountService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PaymentProvider =>
        config.get('PAYMENT_PROVIDER') === 'stripe' ? new StripePaymentProvider() : new FakePaymentProvider(),
    },
  ],
  exports: [PaymentAccountService, PAYMENT_PROVIDER],
})
export class PaymentsModule {}
