import { Injectable, OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { PrismaService } from '../../../database/prisma.service';
import { Prisma } from '../../../generated/prisma/client';
import { localDate, startOfLocalDay } from '../../orders/dates';
import type { CsvCell, CsvColumn } from './csv';
import { PAGE_SIZE } from './export-kinds';
import type { CsvBuilder, ExportContext, ExportKind, accountingParamsSchema } from './export-kinds';
import { ExportsService } from './exports.service';

type Params = z.infer<typeof accountingParamsSchema>;
type Tx = Prisma.TransactionClient;
type Row = Record<string, CsvCell>;

/** The instants a calendar month spans in `timeZone`. */
function monthSpan(month: string, timeZone: string): { gte: Date; lt: Date } {
  const [year, number] = month.split('-').map(Number);
  const next = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
  return { gte: startOfLocalDay(`${month}-01`, timeZone), lt: startOfLocalDay(`${next}-01`, timeZone) };
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const CASH = ['stripe_balance', 'outside_stripe'];
const zero = () => new Prisma.Decimal(0);

/** One accounting kind: its columns and how one page of the month's rows is read. */
function accountingBuilder(
  prisma: PrismaService,
  kind: ExportKind,
  columns: CsvColumn[],
  page: (tx: Tx, span: { gte: Date; lt: Date }, ctx: ExportContext<Params>, skip: number) => Promise<Row[]>,
): CsvBuilder<Params> {
  return {
    kind,
    format: 'csv',
    columns: () => columns,
    async *pages(ctx) {
      const span = monthSpan(ctx.params.month, ctx.timeZone);
      for (let skip = 0; ; skip += PAGE_SIZE) {
        const rows = await prisma.inTenant(ctx.tenantId, (tx) => page(tx, span, ctx, skip));
        yield rows;
        if (rows.length < PAGE_SIZE) return;
      }
    },
  };
}

/**
 * The accountant's month (Reporting 2 spec, goal 10): invoices, payments with their fees, refunds and
 * payouts of one calendar month in the workspace's time zone, one file per kind. Every amount is its
 * record's own, never recomputed. Needs `payment.read`, the kinds' own permission.
 */
@Injectable()
export class AccountingExports implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exports: ExportsService,
  ) {}

  onModuleInit(): void {
    for (const builder of [this.invoices(), this.payments(), this.refunds(), this.payouts()]) {
      this.exports.register(builder as CsvBuilder);
    }
  }

  /** Invoices created in the month, by creation. */
  private invoices(): CsvBuilder<Params> {
    return accountingBuilder(
      this.prisma,
      'accounting_invoices',
      [
        { key: 'invoice_id', label: 'Invoice ID' },
        { key: 'order_number', label: 'Order' },
        { key: 'customer', label: 'Customer' },
        { key: 'created_on', label: 'Created on' },
        { key: 'due_on', label: 'Due on' },
        { key: 'status', label: 'Status' },
        { key: 'paid_on', label: 'Paid on' },
        { key: 'lines', label: 'Lines' },
        { key: 'shipping', label: 'Shipping' },
        { key: 'tax', label: 'Tax' },
        { key: 'total', label: 'Total' },
        { key: 'currency', label: 'Currency' },
        { key: 'provider_invoice_id', label: 'Provider invoice ID' },
      ],
      async (tx, span, ctx, skip) => {
        const invoices = await tx.invoice.findMany({
          where: { createdAt: span },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip,
          take: PAGE_SIZE,
          include: { order: { select: { number: true, customer: { select: { name: true } } } } },
        });
        return invoices.map((invoice) => ({
          invoice_id: invoice.id,
          order_number: invoice.order.number,
          customer: invoice.order.customer.name,
          created_on: localDate(invoice.createdAt, ctx.timeZone),
          due_on: dayOf(invoice.dueOn),
          status: invoice.status,
          paid_on: invoice.paidAt ? localDate(invoice.paidAt, ctx.timeZone) : null,
          lines: invoice.linesAmount,
          shipping: invoice.shipping,
          tax: invoice.tax,
          total: invoice.total,
          currency: invoice.currency,
          provider_invoice_id: invoice.providerInvoiceId,
        }));
      },
    );
  }

  /**
   * Payments received in the month, each with the provider's fee on it, and a reversal of one as its own
   * row with the negative amounts, so totals stay right however the month ended. By when they happened.
   */
  private payments(): CsvBuilder<Params> {
    return accountingBuilder(
      this.prisma,
      'accounting_payments',
      [
        { key: 'journal_id', label: 'Journal ID' },
        { key: 'occurred_at', label: 'Occurred at' },
        { key: 'order_number', label: 'Order' },
        { key: 'customer', label: 'Customer' },
        { key: 'amount', label: 'Amount' },
        { key: 'fee', label: 'Fee' },
        { key: 'net', label: 'Net' },
        { key: 'currency', label: 'Currency' },
        { key: 'method', label: 'Method' },
        { key: 'provider_reference', label: 'Provider reference' },
      ],
      async (tx, span, _ctx, skip) => {
        const journals = await tx.ledgerJournal.findMany({
          where: {
            occurredAt: span,
            OR: [{ kind: 'payment_received' }, { kind: 'reversal', reverses: { kind: 'payment_received' } }],
          },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          skip,
          take: PAGE_SIZE,
          include: {
            lines: { select: { account: true, amount: true } },
            order: { select: { number: true } },
            customer: { select: { name: true } },
            reverses: { select: { providerObjectId: true } },
          },
        });
        const referenceOf = (journal: (typeof journals)[number]) => journal.providerObjectId ?? journal.reverses?.providerObjectId ?? null;
        const references = [...new Set(journals.flatMap((journal) => referenceOf(journal) ?? []))];
        // The fees on these payments, and the reversals of those fees.
        const fees = await tx.ledgerJournal.findMany({
          where: {
            OR: [
              { kind: 'provider_fee', providerObjectId: { in: references } },
              { kind: 'reversal', reverses: { kind: 'provider_fee', providerObjectId: { in: references } } },
            ],
          },
          select: {
            kind: true,
            providerObjectId: true,
            orderId: true,
            reverses: { select: { providerObjectId: true } },
            lines: { where: { account: 'provider_fees' }, select: { amount: true } },
          },
        });
        const feeOf = (reference: string | null, orderId: string | null, reversal: boolean) =>
          fees
            .filter((fee) => (fee.kind === 'reversal') === reversal)
            .filter((fee) => (fee.providerObjectId ?? fee.reverses?.providerObjectId) === reference && fee.orderId === orderId)
            .reduce((sum, fee) => fee.lines.reduce((total, line) => total.add(line.amount), sum), zero());

        return journals.map((journal) => {
          const cash = journal.lines.filter((line) => CASH.includes(line.account));
          const amount = cash.reduce((sum, line) => sum.add(line.amount), zero());
          const reference = referenceOf(journal);
          const fee = reference ? feeOf(reference, journal.orderId, journal.kind === 'reversal') : zero();
          return {
            journal_id: journal.id,
            occurred_at: journal.occurredAt,
            order_number: journal.order?.number ?? null,
            customer: journal.customer?.name ?? null,
            amount,
            fee,
            net: amount.sub(fee),
            currency: journal.currency,
            method: cash[0]?.account === 'outside_stripe' ? 'outside' : 'provider',
            provider_reference: reference,
          };
        });
      },
    );
  }

  /** Refunds asked for in the month, whatever became of them, by creation. */
  private refunds(): CsvBuilder<Params> {
    return accountingBuilder(
      this.prisma,
      'accounting_refunds',
      [
        { key: 'refund_id', label: 'Refund ID' },
        { key: 'order_number', label: 'Order' },
        { key: 'customer', label: 'Customer' },
        { key: 'created_on', label: 'Created on' },
        { key: 'amount', label: 'Amount' },
        { key: 'currency', label: 'Currency' },
        { key: 'kind', label: 'Kind' },
        { key: 'status', label: 'Status' },
        { key: 'reason', label: 'Reason' },
      ],
      async (tx, span, ctx, skip) => {
        const refunds = await tx.refund.findMany({
          where: { createdAt: span },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip,
          take: PAGE_SIZE,
          include: { order: { select: { number: true, currency: true, customer: { select: { name: true } } } } },
        });
        return refunds.map((refund) => ({
          refund_id: refund.id,
          order_number: refund.order.number,
          customer: refund.order.customer.name,
          created_on: localDate(refund.createdAt, ctx.timeZone),
          amount: refund.amount,
          currency: refund.order.currency,
          kind: refund.kind,
          status: refund.status,
          reason: refund.reason,
        }));
      },
    );
  }

  /** Payouts to partners made in the month, whatever became of them, by creation. */
  private payouts(): CsvBuilder<Params> {
    return accountingBuilder(
      this.prisma,
      'accounting_payouts',
      [
        { key: 'payout_id', label: 'Payout ID' },
        { key: 'partner', label: 'Partner' },
        { key: 'created_on', label: 'Created on' },
        { key: 'settled_on', label: 'Settled on' },
        { key: 'amount', label: 'Amount' },
        { key: 'currency', label: 'Currency' },
        { key: 'status', label: 'Status' },
        { key: 'failure', label: 'Failure' },
        { key: 'provider_transfer_id', label: 'Provider transfer ID' },
      ],
      async (tx, span, ctx, skip) => {
        const payouts = await tx.payout.findMany({
          where: { createdAt: span },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip,
          take: PAGE_SIZE,
          include: { partner: { select: { name: true } } },
        });
        return payouts.map((payout) => ({
          payout_id: payout.id,
          partner: payout.partner.name,
          created_on: localDate(payout.createdAt, ctx.timeZone),
          settled_on: payout.settledAt ? localDate(payout.settledAt, ctx.timeZone) : null,
          amount: payout.amount,
          currency: payout.currency,
          status: payout.status,
          failure: payout.failure,
          provider_transfer_id: payout.providerTransferId,
        }));
      },
    );
  }
}
