import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Address } from '../orders/order-response';
import { PaymentAccountService } from './payment-account.service';
import { PAYMENT_PROVIDER } from './payment-provider';
import type { PaymentProvider } from './payment-provider';

/**
 * Our customers as customers at the payment provider, which invoices and subscriptions are made for.
 * Made once, with the customer's id as the idempotency key, and kept on its payment terms.
 */
@Injectable()
export class ProviderCustomers {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: PaymentAccountService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /**
   * The customer's id at the provider, made the first time it is asked for. Outside any transaction.
   * A customer without payment terms gets a `pay_first` row, which is what having none means.
   */
  async ensure(tenantId: string, customerId: string): Promise<string> {
    const found = await this.prisma.inTenant(tenantId, async (tx) => {
      const terms = await tx.customerPaymentTerms.findUnique({ where: { customerId }, select: { providerCustomerId: true } });
      if (terms?.providerCustomerId) return { kind: 'known' as const, id: terms.providerCustomerId };
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { id: true, name: true } });
      // Who the provider sends invoices and receipts to: the customer's first active owner.
      const owner = await tx.organisationMembership.findFirst({
        where: { organisationType: 'customer', organisationId: customerId, role: 'owner', user: { status: 'active' } },
        orderBy: { id: 'asc' },
        select: { user: { select: { email: true } } },
      });
      return { kind: 'new' as const, customer, email: owner?.user.email ?? null };
    });
    if (found.kind === 'known') return found.id;

    const keys = (await this.accounts.keysFor(tenantId)).keys;
    const { id } = await this.provider.ensureCustomer(keys, {
      customerId,
      name: found.customer.name,
      email: found.email,
      idempotencyKey: customerId,
    });
    await this.prisma.inTenant(tenantId, async (tx) => {
      await tx.customerPaymentTerms.upsert({
        where: { customerId },
        create: { customerId, terms: 'pay_first', providerCustomerId: id },
        update: {},
      });
      await tx.customerPaymentTerms.updateMany({ where: { customerId, providerCustomerId: null }, data: { providerCustomerId: id } });
    });
    return id;
  }

  /**
   * Sends what the customer's invoices print to its record at the provider (Customers 2 spec, goal 9): the
   * billing address, else the shipping address, and the VAT number. Outside any transaction. A customer
   * not yet known there is left alone: its first invoice makes the record, and syncs it first.
   */
  async sync(tenantId: string, customerId: string): Promise<void> {
    const found = await this.prisma.inTenant(tenantId, async (tx) => {
      const terms = await tx.customerPaymentTerms.findUnique({ where: { customerId }, select: { providerCustomerId: true } });
      const customer = await tx.customer.findUniqueOrThrow({
        where: { id: customerId },
        select: { shippingAddress: true, billingAddress: true, vatNumber: true },
      });
      return { providerCustomerId: terms?.providerCustomerId ?? null, customer };
    });
    if (!found.providerCustomerId) return;
    const { customer } = found;
    const keys = (await this.accounts.keysFor(tenantId)).keys;
    await this.provider.updateCustomer(keys, found.providerCustomerId, {
      address: ((customer.billingAddress ?? customer.shippingAddress) as Address | null) ?? null,
      vatNumber: customer.vatNumber,
    });
  }
}
