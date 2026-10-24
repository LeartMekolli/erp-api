import { Prisma } from '../../generated/prisma/client';

/**
 * Where each step's price comes from (Partners spec, goal 8 and B1): the workspace's own prices, and
 * for a job costed with a partner, the partner's prices on the partner's steps.
 */
export interface PriceSource<P> {
  /** By step type id: the most specific price for the configuration's material. */
  workspace: Map<string, P>;
  partner?: { partnerStepTypeIds: Set<string>; prices: Map<string, P> };
}

/** The partner's price for a partner step, else the workspace's; a partner step it hasn't priced has none. */
export function pricesFor<P>(source: PriceSource<P>, stepTypeId: string): P | null {
  if (source.partner?.partnerStepTypeIds.has(stepTypeId)) {
    return source.partner.prices.get(stepTypeId) ?? null;
  }
  return source.workspace.get(stepTypeId) ?? null;
}

/** What the partner is paid for a job: its steps' cost per piece × the pieces, rounded once to cents. */
export function partnerCost(
  steps: { key: string; cost: { cost: Prisma.Decimal } }[],
  partnerStepKeys: Set<string>,
  quantity: number,
): Prisma.Decimal {
  return steps
    .filter((step) => partnerStepKeys.has(step.key))
    .reduce((sum, step) => sum.plus(step.cost.cost), new Prisma.Decimal(0))
    .times(quantity)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
