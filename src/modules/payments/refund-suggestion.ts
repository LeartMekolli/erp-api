import { Prisma } from '../../generated/prisma/client';
import { taxAmount } from '../orders/tax';

/**
 * What to refund when lines are cancelled (Payments spec): what the cancelled part cost with its
 * tax, shipping too when the whole order goes, less the work partners are owed for, and never more
 * than is left of what was paid. In-house work counts as nothing.
 */
export function suggestRefund(input: {
  cancelledLinesTotal: Prisma.Decimal;
  /** The order's shipping when every line left is cancelled; else 0. */
  shippingIfWhole: Prisma.Decimal;
  taxPercent: Prisma.Decimal;
  partnersOwed: Prisma.Decimal;
  paidLeft: Prisma.Decimal;
}): { suggested: Prisma.Decimal; workDone: Prisma.Decimal } {
  const { cancelledLinesTotal: lines, shippingIfWhole: shipping } = input;
  const billable = lines.add(shipping).add(taxAmount(input.taxPercent, lines, shipping));
  const suggested = Prisma.Decimal.min(input.paidLeft, Prisma.Decimal.max(0, billable.sub(input.partnersOwed)));
  return { suggested, workDone: input.partnersOwed };
}
