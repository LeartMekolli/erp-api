import { Prisma } from '../../generated/prisma/client';
import type { Breakdown } from './engine';
import { SUMMARY_GROUPS } from './pricing-response';
import type { SummaryGroup } from './pricing-response';

const CENTS = 2;
const cents = (value: Prisma.Decimal) => value.toDecimalPlaces(CENTS, Prisma.Decimal.ROUND_HALF_UP);

export type SummaryLabel = SummaryGroup | 'quantity_discount' | 'your_discount' | 'plan_discount' | 'delivery_speed';

/** What a customer sees of a price: nothing but labelled amounts that add up to it. */
export interface CustomerSummary {
  lines: { label: SummaryLabel; amount: Prisma.Decimal }[];
  unitPrice: Prisma.Decimal;
}

/**
 * The customer's view of a breakdown (Pricing spec, Q1). The quantity discount, a negative customer
 * group and the delivery speed show as their own lines; the rest of the price is split over
 * material (every material block, the batch's lost material included), making and finishing (the
 * other blocks, by their step's group) in proportion to their cost, so overhead, margin, failure
 * allowance, the minimum-size surcharge and a positive group are spread and never shown. Lines are
 * rounded to cents and the difference goes to the largest, so they always sum to the price.
 */
export function customerSummary(breakdown: Breakdown): CustomerSummary {
  const visible: CustomerSummary['lines'] = [];
  for (const adjustment of breakdown.adjustments) {
    if (adjustment.kind === 'customer_group' && !adjustment.percent.isNegative()) continue;
    const label = adjustment.kind === 'customer_group' ? 'your_discount' : adjustment.kind === 'plan' ? 'plan_discount' : adjustment.kind;
    visible.push({ label, amount: cents(adjustment.amount) });
  }

  const costs = new Map<SummaryGroup, Prisma.Decimal>(SUMMARY_GROUPS.map((group) => [group, new Prisma.Decimal(0)]));
  for (const step of breakdown.steps) {
    for (const block of step.cost.blocks) {
      const group = block.kind === 'material' || block.kind === 'batch_material' ? 'material' : step.summaryGroup;
      costs.set(group, costs.get(group)!.plus(block.amount));
    }
  }
  const totalCost = [...costs.values()].reduce((sum, cost) => sum.plus(cost), new Prisma.Decimal(0));
  const base = visible.reduce((rest, line) => rest.minus(line.amount), breakdown.unitPrice);

  const exact = SUMMARY_GROUPS.map((group) => ({
    label: group,
    share: totalCost.isZero() ? (group === 'making' ? base : new Prisma.Decimal(0)) : base.times(costs.get(group)!).dividedBy(totalCost),
  }));
  const split = exact.map((line) => ({ label: line.label, amount: cents(line.share) }));
  const difference = split.reduce((rest, line) => rest.minus(line.amount), base);
  const largest = exact.reduce((best, line, index) => (line.share.greaterThan(exact[best].share) ? index : best), 0);
  split[largest].amount = split[largest].amount.plus(difference);

  return {
    lines: [...split, ...visible].filter((line) => !line.amount.isZero()),
    unitPrice: breakdown.unitPrice,
  };
}
