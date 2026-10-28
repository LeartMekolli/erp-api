import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Invoice, PaymentEvent, Prisma } from '../../generated/prisma/client';
import { JobsService } from '../../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { localDate } from '../orders/dates';
import { OrdersService } from '../orders/orders.service';
import { billedJournal, feeJournal, receivedJournal } from './ledger';
import { LedgerService } from './ledger.service';
import { PaymentAccountService } from './payment-account.service';
import { registerEventHandler } from './payment-events.service';
import { PAYMENT_PROVIDER } from './payment-provider';
import type { PaymentProvider } from './payment-provider';
import { DEFAULT_DAYS_TO_PAY } from './payment-response';
import { billableTotals, paidAndRefunded } from './payment-state';

const DAY_MS = 86_400_000;

/** `day` (YYYY-MM-DD) as the date column stores it. */
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
const money = (amount: Prisma.Decimal, currency: string) => `${amount.toFixed(2)} ${currency}`;

/**
 * Invoices for pay-later orders (Payments spec): made once an order ships, paid by webhook, and told
 * about once when overdue. Our row is written first; the provider is called outside any transaction,
 * with the row's id as its idempotency key, so a retried job makes the same invoice there.
 */
@Injectable()
export class InvoicesService implements OnModuleInit {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly accounts: PaymentAccountService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly orders: OrdersService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  onModuleInit(): void {
    this.orders.registerPaymentHooks({
      shipped: (tenantId, orderId) => this.jobs.enqueue('payments.invoice.create', { tenantId, orderId }),
    });
    registerEventHandler('invoice.paid', (tenantId, event) => this.paid(tenantId, event));
    registerEventHandler('invoice.payment_succeeded', (tenantId, event) => this.paid(tenantId, event));
  }

  /**
   * Invoices a shipped pay-later order not paid, cancelled or invoiced already: its live lines,
   * shipping and tax, due in the customer's days to pay from today in the workspace. Safe to run
   * again: an invoice made already is left as it is, and one half made is finished.
   */
  async create(tenantId: string, orderId: string): Promise<void> {
    const keys = (await this.accounts.keysFor(tenantId)).keys;
    const prepared = await this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      if (rows.length === 0) return null;
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      const journals = await tx.ledgerJournal.findMany({
        where: { orderId, kind: { in: ['payment_received', 'refund'] } },
        select: { kind: true, lines: { select: { account: true, amount: true } } },
      });
      if (order.paymentTerms !== 'pay_later' || order.cancelledAt || !order.shippedAt || paidAndRefunded(journals).paid.gt(0)) return null;
      const existing = await tx.invoice.findFirst({ where: { orderId } });
      if (existing && existing.status !== 'creating') return null;

      const lines = await tx.orderLine.findMany({
        where: { orderId, cancelledAt: null },
        orderBy: { position: 'asc' },
        select: { quantity: true, total: true, product: { select: { name: true } } },
      });
      const terms = await tx.customerPaymentTerms.findUnique({ where: { customerId: order.customerId } });
      const daysToPay = terms?.daysToPay ?? DEFAULT_DAYS_TO_PAY;
      let invoice: Invoice;
      if (existing) {
        invoice = existing;
      } else {
        const totals = billableTotals(order, lines.map((line) => line.total));
        if (totals.total.isZero()) return null;
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
        const today = localDate(new Date(), tenant.timezone);
        invoice = await tx.invoice.create({
          data: {
            orderId,
            linesAmount: totals.lines,
            shipping: totals.shipping,
            tax: totals.tax,
            total: totals.total,
            currency: order.currency,
            dueOn: new Date(asDate(today).getTime() + daysToPay * DAY_MS),
            status: 'creating',
          },
        });
      }
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: order.customerId }, select: { id: true, name: true } });
      // Who the provider sends the invoice to: the customer's first active owner.
      const owner = await tx.organisationMembership.findFirst({
        where: { organisationType: 'customer', organisationId: customer.id, role: 'owner', user: { status: 'active' } },
        orderBy: { id: 'asc' },
        select: { user: { select: { email: true } } },
      });
      return { order, invoice, lines, daysToPay, customer, email: owner?.user.email ?? null, providerCustomerId: terms?.providerCustomerId ?? null };
    });
    if (!prepared) return;
    const { order, invoice, customer } = prepared;

    let providerCustomerId = prepared.providerCustomerId;
    if (!providerCustomerId) {
      providerCustomerId = (
        await this.provider.ensureCustomer(keys, { customerId: customer.id, name: customer.name, email: prepared.email, idempotencyKey: customer.id })
      ).id;
      const stored = providerCustomerId;
      await this.prisma.inTenant(tenantId, (tx) =>
        tx.customerPaymentTerms.updateMany({ where: { customerId: customer.id }, data: { providerCustomerId: stored } }),
      );
    }
    const made = await this.provider.createInvoice(keys, {
      providerCustomerId,
      currency: invoice.currency,
      lines: [
        ...prepared.lines.map((line) => ({ description: `${line.product.name} × ${line.quantity}`, amount: line.total })),
        ...(invoice.shipping.isZero() ? [] : [{ description: 'Shipping', amount: invoice.shipping }]),
      ],
      tax: invoice.tax,
      daysUntilDue: prepared.daysToPay,
      metadata: { tenant_id: tenantId, order_id: order.id, invoice_id: invoice.id },
      idempotencyKey: invoice.id,
    });

    const opened = await this.prisma.inTenant(tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${order.id}::uuid FOR UPDATE`;
      const updated = await tx.invoice.updateMany({
        where: { id: invoice.id, status: 'creating' },
        data: { status: 'open', url: made.url, providerInvoiceId: made.id },
      });
      if (updated.count === 0) return false;
      await this.ledger.post(tx, {
        ...billedJournal(order.customerId, invoice.total, invoice.tax),
        occurredAt: new Date(),
        currency: invoice.currency,
        orderId: order.id,
        customerId: order.customerId,
        providerObjectId: made.id,
        memo: `Order ${order.number} invoiced`,
      });
      return true;
    });
    if (!opened) return;
    await this.tell(tenantId, order.id, () =>
      this.notifications.raise(tenantId, 'invoice.sent', { type: 'order', id: order.id }, {
        number: String(order.number),
        total: money(invoice.total, invoice.currency),
        invoice_url: made.url,
        due_on: invoice.dueOn.toISOString().slice(0, 10),
      }),
    );
  }

  /**
   * An invoice of ours the provider says is paid: the payment and the provider's fee are journalled
   * once, and the invoice is paid. Anything else, or a repeat, changes nothing.
   */
  async paid(tenantId: string, event: PaymentEvent): Promise<void> {
    const row = await this.prisma.inTenant(tenantId, (tx) =>
      tx.invoice.findFirst({ where: { providerInvoiceId: event.objectId }, select: { id: true, orderId: true } }),
    );
    if (!row) return;
    const fetched = await this.provider.getInvoice((await this.accounts.keysFor(tenantId)).keys, event.objectId);
    if (!fetched.paid) return;

    const outcome = await this.prisma.inTenant(tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${row.orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: row.orderId } });
      await tx.invoice.updateMany({ where: { id: row.id, status: 'open' }, data: { status: 'paid', paidAt: new Date() } });
      const common = {
        occurredAt: new Date(),
        currency: order.currency,
        orderId: order.id,
        customerId: order.customerId,
        providerObjectId: event.objectId,
      };
      const received = await this.ledger.post(tx, {
        ...receivedJournal(order.customerId, fetched.amount, 'stripe_balance'),
        ...common,
        memo: `Order ${order.number} paid by invoice`,
      });
      if (fetched.fee.gt(0)) {
        await this.ledger.post(tx, { ...feeJournal(fetched.fee), ...common, memo: `Fee on order ${order.number}` });
      }
      return { order, newlyPaid: received.created };
    });
    if (!outcome.newlyPaid) return;
    await this.tell(tenantId, outcome.order.id, () =>
      this.notifications.raise(tenantId, 'payment.received', { type: 'order', id: outcome.order.id }, {
        number: String(outcome.order.number),
        amount: money(fetched.amount, outcome.order.currency),
      }),
    );
  }

  /**
   * Tells the customer and staff of each open invoice past its due date in its workspace, once: the
   * invoice is marked told before anyone is, so a second run tells nobody again.
   */
  async notifyOverdue(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true, timezone: true } });
    for (const tenant of tenants) {
      const today = asDate(localDate(new Date(), tenant.timezone));
      const due = await this.prisma.inTenant(tenant.id, (tx) =>
        tx.invoice.findMany({
          where: { status: 'open', overdueNotifiedAt: null, dueOn: { lt: today } },
          select: { id: true },
          orderBy: { id: 'asc' },
        }),
      );
      for (const { id } of due) {
        // One invoice failing must not keep the others untold.
        try {
          await this.notifyOneOverdue(tenant.id, id);
        } catch (error) {
          this.logger.error({ err: error, tenantId: tenant.id, invoiceId: id }, 'telling of an overdue invoice failed');
        }
      }
    }
  }

  private async notifyOneOverdue(tenantId: string, invoiceId: string): Promise<void> {
    const marked = await this.prisma.inTenant(tenantId, async (tx) => {
      const updated = await tx.invoice.updateMany({
        where: { id: invoiceId, status: 'open', overdueNotifiedAt: null },
        data: { overdueNotifiedAt: new Date() },
      });
      if (updated.count === 0) return null;
      return tx.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: { order: { select: { id: true, number: true, customer: { select: { name: true } } } } },
      });
    });
    if (!marked) return;
    const subject = { type: 'order', id: marked.order.id };
    const common = {
      number: String(marked.order.number),
      total: money(marked.total, marked.currency),
      due_on: marked.dueOn.toISOString().slice(0, 10),
    };
    await this.tell(tenantId, marked.order.id, () =>
      this.notifications.raise(tenantId, 'invoice.overdue', subject, { ...common, invoice_url: marked.url ?? '' }),
    );
    await this.tell(tenantId, marked.order.id, () =>
      this.notifications.raise(tenantId, 'invoice.overdue.staff', subject, { ...common, customer_name: marked.order.customer.name }),
    );
  }

  /** After commit: a failure to tell is logged; what was recorded stays recorded. */
  private async tell(tenantId: string, orderId: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.logger.error({ err: error, tenantId, orderId }, 'a notification about an invoice failed');
    }
  }
}
