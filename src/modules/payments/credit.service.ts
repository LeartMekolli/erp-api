import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { TenantAuth } from '../identity/auth-context';
import { localDate } from '../orders/dates';
import type { OrderResponse } from '../orders/order-response';
import { OrdersService } from '../orders/orders.service';
import { CheckoutService } from './checkout.service';
import { creditExposure } from './credit';
import { LedgerService } from './ledger.service';
import { OrderStarter } from './order-starter';
import { paymentTermsResponse } from './payment-response';
import type { PaymentCustomerResponse } from './payment-response';

/** Pay-later customers within a credit limit (Payments spec, M6): releasing a held order, and what a customer owes. */
@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly checkout: CheckoutService,
    private readonly starter: OrderStarter,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Staff let an order held for its credit limit through: in one transaction it is released, its
   * open checkout can no longer be paid, and it starts. From then on it is a pay-later order like any
   * other, counted in what the customer owes.
   */
  async release(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, orderId: string, reason: string): Promise<OrderResponse> {
    const { started, expired } = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.orders.releaseHeld(tx, auth, orderId, reason);
      const expired = await this.checkout.expireRows(tx, orderId);
      const started = await this.starter.start(tx, auth.tenantId, orderId, { type: 'user', id: auth.userId });
      return { started, expired };
    });
    // The release has committed: a failure from here on is logged, never answered.
    try {
      await this.checkout.expireAt(auth.tenantId, expired);
    } catch (error) {
      this.logger.error({ err: error, orderId }, 'expiring the checkout of a released order failed');
    }
    await this.starter.announce(auth.tenantId, started);
    return this.orders.get(auth.tenantId, orderId);
  }

  /** The customer's terms, what it owes or will owe, and its open invoices: past due or not, in the workspace's today. */
  async customer(tenantId: string, customerId: string): Promise<PaymentCustomerResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      // Row-level security hides other workspaces' customers, so a foreign id is simply not found.
      if (!(await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } }))) {
        throw new NotFoundException('Customer not found');
      }
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
      const today = localDate(new Date(), tenant.timezone);
      const invoices = (
        await tx.invoice.findMany({
          where: { status: 'open', order: { customerId } },
          orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
          include: { order: { select: { number: true } } },
        })
      ).map((row) => ({
        order_id: row.orderId,
        order_number: row.order.number,
        total: row.total.toFixed(2),
        currency: row.currency,
        due_on: row.dueOn.toISOString().slice(0, 10),
        url: row.url,
      }));
      return {
        ...paymentTermsResponse(await tx.customerPaymentTerms.findUnique({ where: { customerId } })),
        exposure: (await creditExposure(tx, customerId)).toFixed(2),
        balance: (await this.ledger.balance(tx, 'customer_receivable', { customerId })).toFixed(2),
        open_invoices: invoices.filter((invoice) => invoice.due_on >= today),
        overdue_invoices: invoices.filter((invoice) => invoice.due_on < today),
      };
    });
  }
}
