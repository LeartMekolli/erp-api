import { Body, Controller, Get, Put } from '@nestjs/common';
import type { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PrismaService } from '../../database/prisma.service';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { PaymentAccountService } from './payment-account.service';
import { paymentAccountResponseSchema, setPaymentAccountSchema } from './payment-response';
import type { PaymentAccountResponse } from './payment-response';

/** The workspace's own Stripe account (Payments spec): keys in, never out. */
@Controller('payments/account')
export class PaymentAccountController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly account: PaymentAccountService,
  ) {}

  @ApiDoc({
    summary: "Whether the workspace's payment account is set up, its mode, and the webhook addresses to register.",
    description: 'Never includes a key or a signing secret.',
    response: paymentAccountResponseSchema,
  })
  @RequirePermission('payment.setup')
  @Get()
  get(@CurrentTenant() tenantId: string): Promise<PaymentAccountResponse> {
    return this.prisma.inTenant(tenantId, (tx) => this.account.view(tx, tenantId));
  }

  @ApiDoc({
    summary: "Set the workspace's Stripe keys and signing secrets, replacing any set before.",
    description:
      'The secret key starts with sk_ or rk_, the publishable key with pk_, and both signing secrets with whsec_. They are sealed at rest and never returned.',
    body: setPaymentAccountSchema,
    response: paymentAccountResponseSchema,
    errors: [400],
  })
  @RequirePermission('payment.setup')
  @Put()
  set(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(setPaymentAccountSchema)) body: z.infer<typeof setPaymentAccountSchema>,
  ): Promise<PaymentAccountResponse> {
    return this.prisma.inTenant(auth.tenantId, (tx) => this.account.set(tx, auth, body));
  }
}
