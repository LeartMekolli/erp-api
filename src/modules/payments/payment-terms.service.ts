import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { lockCustomer } from '../customers/lock-customer';
import type { TenantAuth } from '../identity/auth-context';
import { paymentTermsResponse } from './payment-response';
import { planOf } from './plans/plan-of';
import type { PaymentTermsResponse, SetPaymentTerms } from './payment-response';
import { workspaceCurrency } from './workspace-currency';

/** How each customer pays (Payments spec): first, or later within some days and up to a limit. */
@Injectable()
export class PaymentTermsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Replaces the customer's terms; orders placed already keep the terms they were placed under. Pay
   * later needs a plan that allows it (Payments 2, goal 8); terms already set are never changed by a
   * plan change.
   */
  async set(auth: TenantAuth, customerId: string, input: SetPaymentTerms): Promise<PaymentTermsResponse> {
    return this.prisma.inTenant(auth.tenantId, (tx) => writePaymentTerms(tx, this.audit, auth.userId, customerId, input));
  }
}

/**
 * Replaces the customer's terms inside the caller's transaction. A plain function rather than a
 * service method, so customer creation can call it: PaymentsModule imports CustomersModule.
 */
export async function writePaymentTerms(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  actorUserId: string,
  customerId: string,
  input: SetPaymentTerms,
): Promise<PaymentTermsResponse> {
  await lockCustomer(tx, customerId);
  if (input.terms === 'pay_later') {
    const plan = await planOf(tx, customerId);
    if (!plan.features.has('pay_later')) {
      const message = `The customer's plan (${plan.name}) doesn't allow pay later`;
      throw new ConflictException({ message, errors: [{ path: 'terms', message }] });
    }
  }
  const currency = await workspaceCurrency(tx);
  const before = paymentTermsResponse(await tx.customerPaymentTerms.findUnique({ where: { customerId } }), currency);
  const data = {
    terms: input.terms,
    daysToPay: input.days_to_pay,
    creditLimit: input.credit_limit === null ? null : new Prisma.Decimal(input.credit_limit),
  };
  const row = await tx.customerPaymentTerms.upsert({
    where: { customerId },
    create: { customerId, ...data },
    update: data,
  });
  const after = paymentTermsResponse(row, currency);
  await audit.record(tx, {
    actor: { type: 'user', id: actorUserId },
    action: 'customer.payment_terms.changed',
    subject: { type: 'customer', id: customerId },
    before,
    after,
  });
  return after;
}
