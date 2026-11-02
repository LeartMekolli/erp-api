import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { Invoice } from '../../generated/prisma/client';
import { JobsService as QueueService } from '../../jobs/jobs.service';
import { creditNoteJournal } from './ledger';
import { LedgerService } from './ledger.service';
import { PaymentAccountService } from './payment-account.service';
import { PAYMENT_PROVIDER } from './payment-provider';
import type { PaymentProvider } from './payment-provider';
import { paidAndRefunded } from './payment-state';

type Tx = Prisma.TransactionClient;

/**
 * What is still open on an invoice: its total, less what was paid for its order and what credit notes take
 * off it. `counting` names the credit notes that count: issued ones for what is due, pending ones too for
 * what a new credit note may still take.
 */
export async function openOnInvoice(
  tx: Tx,
  invoice: Pick<Invoice, 'id' | 'orderId' | 'total'>,
  counting: ('pending' | 'issued')[] = ['issued'],
): Promise<Prisma.Decimal> {
  const credited = await tx.creditNote.aggregate({ _sum: { amount: true }, where: { invoiceId: invoice.id, status: { in: counting } } });
  const journals = await tx.ledgerJournal.findMany({
    where: { orderId: invoice.orderId, kind: 'payment_received' },
    select: { kind: true, lines: { select: { account: true, amount: true } } },
  });
  return invoice.total.sub(credited._sum.amount ?? 0).sub(paidAndRefunded(journals).paid);
}

/**
 * Credit notes (Orders 3 spec, goal 3): the part of a claim's refund that was never paid lowers the
 * order's open invoice instead, so the customer never pays first to be paid back. Written pending in the
 * caller's transaction, asked for at the provider by a job after the commit, then journalled once.
 */
@Injectable()
export class CreditNotesService {
  private readonly logger = new Logger(CreditNotesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly accounts: PaymentAccountService,
    private readonly ledger: LedgerService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /**
   * Writes a pending credit note on the order's open invoice, under the order's lock the caller holds.
   * Answers null when there is no open invoice, or `amount` passes what is still open on it.
   */
  async create(tx: Tx, input: { orderId: string; claimLineId: string; amount: Prisma.Decimal }): Promise<string | null> {
    const invoice = await tx.invoice.findFirst({ where: { orderId: input.orderId, status: 'open' } });
    if (!invoice || input.amount.gt(await openOnInvoice(tx, invoice, ['pending', 'issued']))) return null;
    const note = await tx.creditNote.create({
      data: { orderId: input.orderId, invoiceId: invoice.id, claimLineId: input.claimLineId, amount: input.amount },
    });
    return note.id;
  }

  /** What `create` would allow now on the order's open invoice; 0 without one. */
  async creditable(tx: Tx, orderId: string): Promise<Prisma.Decimal> {
    const invoice = await tx.invoice.findFirst({ where: { orderId, status: 'open' } });
    if (!invoice) return new Prisma.Decimal(0);
    return Prisma.Decimal.max(0, await openOnInvoice(tx, invoice, ['pending', 'issued']));
  }

  /** After the commit: queues the provider's side. If queueing fails, the job's retry is lost; it is logged. */
  async afterCreate(tenantId: string, creditNoteId: string): Promise<void> {
    await this.queue.enqueue('payments.credit_note', { tenantId, creditNoteId });
  }

  /**
   * The job: asks the provider, with the credit note's id as the idempotency key, then marks it issued and
   * journals it under the order's lock. One no longer pending is left as it is.
   */
  async process(tenantId: string, creditNoteId: string): Promise<void> {
    const found = await this.prisma.inTenant(tenantId, (tx) =>
      tx.creditNote.findUnique({
        where: { id: creditNoteId },
        include: { invoice: true, claimLine: { select: { claim: { select: { number: true } } } } },
      }),
    );
    if (!found || found.status !== 'pending') return;
    if (!found.invoice.providerInvoiceId) throw new Error(`Invoice ${found.invoiceId} has no invoice at the provider`);
    const keys = (await this.accounts.keysFor(tenantId)).keys;
    const made = await this.provider.createCreditNote(keys, {
      invoiceId: found.invoice.providerInvoiceId,
      amount: found.amount,
      currency: found.invoice.currency,
      reason: `Claim ${found.claimLine.claim.number}`,
      idempotencyKey: found.id,
    });
    await this.prisma.inTenant(tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${found.orderId}::uuid FOR UPDATE`;
      const note = await tx.creditNote.findUniqueOrThrow({ where: { id: creditNoteId } });
      if (note.status !== 'pending') return;
      const order = await tx.order.findUniqueOrThrow({ where: { id: note.orderId } });
      // Tax gives back its share of what the order cost, as for a refund.
      const tax = order.total.isZero()
        ? new Prisma.Decimal(0)
        : note.amount.mul(order.taxAmount).div(order.total).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      await this.ledger.post(tx, {
        ...creditNoteJournal(order.customerId, note.amount, tax),
        occurredAt: new Date(),
        currency: order.currency,
        orderId: order.id,
        customerId: order.customerId,
        providerObjectId: made.id,
        memo: `Credit note on order ${order.number}: claim ${found.claimLine.claim.number}`,
      });
      await tx.creditNote.update({ where: { id: note.id }, data: { status: 'issued', providerCreditNoteId: made.id } });
    });
  }

  /** After the job's last attempt: failed, for staff to settle by hand. */
  async failed(tenantId: string, creditNoteId: string): Promise<void> {
    await this.prisma.inTenant(tenantId, (tx) => tx.creditNote.updateMany({ where: { id: creditNoteId, status: 'pending' }, data: { status: 'failed' } }));
    this.logger.error({ tenantId, creditNoteId }, 'a credit note could not be issued at the provider');
  }
}
