import { Prisma } from '../../generated/prisma/client';
import { SUMMARY_LABELS } from './quote-response';
import type { CustomerSummary } from './summary';

/** A priced piece: what one costs the customer, and its summary lines, which add up to it. */
export interface PricedPiece {
  unitPrice: Prisma.Decimal;
  summary: CustomerSummary['lines'];
}

/**
 * One assembly's price (Orders spec, goal 6): its own steps plus each part times how many go into
 * one, so the line's total is exactly its own total plus every part's. The customer's summary merges
 * the lines by label, each part's line times its number per assembly; already in cents, they still
 * add up to the price. A label that comes to nothing is left out.
 */
export function composeAssembly(
  own: PricedPiece,
  parts: (PricedPiece & { quantityPer: number })[],
  quantity: number,
): { unitPrice: Prisma.Decimal; total: Prisma.Decimal; summary: CustomerSummary['lines'] } {
  const unitPrice = parts.reduce((sum, part) => sum.plus(part.unitPrice.times(part.quantityPer)), own.unitPrice);
  const byLabel = new Map<CustomerSummary['lines'][number]['label'], Prisma.Decimal>();
  const add = (lines: CustomerSummary['lines'], times: number) => {
    for (const line of lines) {
      byLabel.set(line.label, (byLabel.get(line.label) ?? new Prisma.Decimal(0)).plus(line.amount.times(times)));
    }
  };
  add(own.summary, 1);
  for (const part of parts) add(part.summary, part.quantityPer);
  const summary = SUMMARY_LABELS.flatMap((label) => {
    const amount = byLabel.get(label);
    return amount && !amount.isZero() ? [{ label, amount }] : [];
  });
  return { unitPrice, total: unitPrice.times(quantity), summary };
}
