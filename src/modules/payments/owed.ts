import type { Prisma } from '../../generated/prisma/client';
import { CASH_ACCOUNTS } from './payment-state';

type Tx = Prisma.TransactionClient;

/**
 * What is still owed on the orders, summed per currency (Orders list extras spec, goal 2). Per order, as
 * `openOnInvoice` gives it for an overdue reminder: the invoice's total less its issued credit notes, or the
 * order total while there is no invoice (a void one counts as none), less what was paid for the order on a
 * cash account; never below 0. Sorted by currency, a currency owing nothing left out. One query, whatever
 * the number of orders.
 */
export async function owedByCurrency(tx: Tx, orderIds: string[]): Promise<{ currency: string; amount: string }[]> {
  if (orderIds.length === 0) return [];
  return tx.$queryRaw<{ currency: string; amount: string }[]>`
    SELECT owed.currency, SUM(owed.amount)::text AS amount FROM (
      SELECT COALESCE(i.currency, o.currency) AS currency,
             GREATEST(0, COALESCE(i.total - COALESCE(c.credited, 0), o.total) - COALESCE(p.paid, 0)) AS amount
      FROM "order" o
      LEFT JOIN invoice i ON i.order_id = o.id AND i.status <> 'void'
      LEFT JOIN (
        SELECT invoice_id, SUM(amount) AS credited FROM credit_note WHERE status = 'issued' GROUP BY invoice_id
      ) c ON c.invoice_id = i.id
      LEFT JOIN (
        SELECT j.order_id, SUM(l.amount) AS paid
        FROM ledger_journal j JOIN ledger_line l ON l.journal_id = j.id
        WHERE j.kind = 'payment_received' AND l.account = ANY(${[...CASH_ACCOUNTS]}::text[])
        GROUP BY j.order_id
      ) p ON p.order_id = o.id
      WHERE o.id = ANY(${orderIds}::uuid[])
    ) owed
    GROUP BY owed.currency
    HAVING SUM(owed.amount) > 0
    ORDER BY owed.currency`;
}
