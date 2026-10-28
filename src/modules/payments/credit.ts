import { Prisma } from '../../generated/prisma/client';
import { billableTotals, paidAndRefunded } from './payment-state';

// A pay-later customer's credit (Payments spec, M6): what it owes now, against its limit.

/** The order would take the customer past its limit. A customer without a limit never is. */
export function overLimit(exposure: Prisma.Decimal, orderTotal: Prisma.Decimal, limit: Prisma.Decimal | null): boolean {
  return limit !== null && exposure.add(orderTotal).gt(limit);
}

/**
 * What the customer owes or will owe: its receivable in the ledger (billed and not paid), plus what
 * its started pay-later orders that are neither cancelled nor billed nor paid will cost. A started
 * order is one that was never held, or was released; an order held for credit waits for a card
 * payment, so it doesn't count until it is released.
 */
export async function creditExposure(tx: Prisma.TransactionClient, customerId: string): Promise<Prisma.Decimal> {
  const receivable = await tx.ledgerLine.aggregate({
    _sum: { amount: true },
    where: { account: 'customer_receivable', customerId },
  });
  const orders = await tx.order.findMany({
    where: { customerId, paymentTerms: 'pay_later', cancelledAt: null, productionStartedAt: { not: null } },
    select: {
      shippingPrice: true,
      taxPercent: true,
      lines: { where: { cancelledAt: null }, select: { total: true } },
      ledgerJournals: {
        where: { kind: { in: ['order_billed', 'payment_received', 'refund'] } },
        select: { kind: true, lines: { select: { account: true, amount: true } } },
      },
    },
  });
  let exposure = receivable._sum.amount ?? new Prisma.Decimal(0);
  for (const order of orders) {
    // Billed already: its amount is in the receivable. Paid: nothing is owed for it.
    if (order.ledgerJournals.some((journal) => journal.kind === 'order_billed')) continue;
    if (paidAndRefunded(order.ledgerJournals).paid.gt(0)) continue;
    exposure = exposure.add(billableTotals(order, order.lines.map((line) => line.total)).total);
  }
  return exposure;
}
