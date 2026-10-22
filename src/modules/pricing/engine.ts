import { Prisma } from '../../generated/prisma/client';
import type { ScalableMeasure } from '../catalog/scaling';
import type { UnitDef } from '../catalog/units';
import type { MeasureType } from '../files/measurers';
import type { Block } from './blocks';
import type { ChainStep } from './chain';
import type { SummaryGroup } from './pricing-response';
import { costStep } from './step-cost';
import type { PricedMaterial, StepCost, StepRefusal } from './step-cost';

/** Intermediate amounts keep 10 places; the price per piece is rounded once, to cents, half up (P11). */
const PLACES = 10;
const CENTS = 2;
const round = (value: Prisma.Decimal) => value.toDecimalPlaces(PLACES, Prisma.Decimal.ROUND_HALF_UP);
const percentOf = (value: Prisma.Decimal, percent: Prisma.Decimal) => round(value.times(percent).dividedBy(100));

export interface EngineInput {
  quantity: number;
  /** The configuration's chain, each step with its price (the material's own, else the step's default), or null. */
  steps: { step: ChainStep; price: { failurePercent: Prisma.Decimal; blocks: Block[] } | null }[];
  /** The design's measures at the chosen size, in base units (mm, mm2, mm3, piece). */
  measures: ScalableMeasure[];
  units: UnitDef[];
  /** The configuration's material under `'configuration'`, every material named on a block under its id. */
  materials: Map<string, PricedMaterial>;
  overheadPerPiece: Prisma.Decimal;
  /** `below` in the measure's base unit. */
  minSize: { measure: MeasureType; below: Prisma.Decimal; amount: Prisma.Decimal }[];
  marginPercent: Prisma.Decimal;
  /** The quantity discount tier reached (`tierFor`), or null. */
  tier: Prisma.Decimal | null;
  groupPercent: Prisma.Decimal | null;
  speedPercent: Prisma.Decimal | null;
}

export interface PricingRefusal {
  code: 'no_steps' | 'step_price_missing' | 'price_too_large' | StepRefusal['code'];
  /** The step's key, when one step is the cause. */
  step?: string;
  message: string;
}

/** Quote prices are stored as Decimal(18, 2): below 10^16. */
const PRICE_LIMIT = new Prisma.Decimal('1e16');

export interface Breakdown {
  steps: { key: string; name: string; summaryGroup: SummaryGroup; cost: StepCost }[];
  /** Σ step costs, per piece. */
  costPerPiece: Prisma.Decimal;
  overhead: Prisma.Decimal;
  minSizeSurcharge: Prisma.Decimal;
  margin: { percent: Prisma.Decimal; amount: Prisma.Decimal };
  priceBeforeAdjustments: Prisma.Decimal;
  /** In the order applied, each on the result of the one before; discounts are negative. */
  adjustments: { kind: 'quantity_discount' | 'customer_group' | 'delivery_speed'; percent: Prisma.Decimal; amount: Prisma.Decimal }[];
  unitPriceExact: Prisma.Decimal;
  /** Rounded to cents. */
  unitPrice: Prisma.Decimal;
  /** `unitPrice` × quantity. */
  total: Prisma.Decimal;
}

export type EngineResult = { accepted: true; breakdown: Breakdown } | { accepted: false; reasons: PricingRefusal[] };

/** The percent of the highest tier the quantity reaches, whatever the list order (P6), or null. */
export function tierFor(tiers: { minQuantity: number; percent: Prisma.Decimal }[], quantity: number): Prisma.Decimal | null {
  const reached = tiers.filter((tier) => quantity >= tier.minQuantity);
  if (reached.length === 0) return null;
  return reached.reduce((best, tier) => (tier.minQuantity > best.minQuantity ? tier : best)).percent;
}

/**
 * A configuration's price per piece (Pricing spec, "Order of calculation" 3–7): each step's cost,
 * plus overhead and the highest matching minimum-size surcharge, × (1 + margin); then the quantity
 * discount, the customer group and the delivery speed, each on the result of the one before; then
 * rounded once. Every step that cannot be priced is reported, not just the first.
 */
export function priceConfiguration(input: EngineInput): EngineResult {
  if (input.steps.length === 0) {
    // Material is only charged through a step, so a chain without steps would price nothing but overhead.
    return { accepted: false, reasons: [{ code: 'no_steps', message: 'No production steps are set for this product' }] };
  }
  const chain = [...input.steps].sort((a, b) => a.step.position - b.step.position || a.step.key.localeCompare(b.step.key));
  const reasons: PricingRefusal[] = [];
  const steps: Breakdown['steps'] = [];
  for (const { step, price } of chain) {
    if (!price) {
      reasons.push({ code: 'step_price_missing', step: step.key, message: `Step ${step.key} has no price` });
      continue;
    }
    const cost = costStep({
      blocks: price.blocks,
      failurePercent: price.failurePercent,
      quantity: input.quantity,
      measures: input.measures,
      units: input.units,
      materials: input.materials,
    });
    if ('code' in cost) {
      reasons.push({ code: cost.code, step: step.key, message: `Step ${step.key}: ${cost.message}` });
      continue;
    }
    steps.push({ key: step.key, name: step.name, summaryGroup: step.summaryGroup, cost });
  }
  if (reasons.length > 0) {
    return { accepted: false, reasons };
  }

  const costPerPiece = steps.reduce((sum, line) => sum.plus(line.cost.cost), new Prisma.Decimal(0));
  const minSizeSurcharge = input.minSize
    .filter((rule) => input.measures.some((measure) => measure.type === rule.measure && measure.value.lessThan(rule.below)))
    .reduce((highest, rule) => Prisma.Decimal.max(highest, rule.amount), new Prisma.Decimal(0));
  const base = costPerPiece.plus(input.overheadPerPiece).plus(minSizeSurcharge);
  const marginAmount = percentOf(base, input.marginPercent);
  const priceBeforeAdjustments = base.plus(marginAmount);

  let running = priceBeforeAdjustments;
  const adjustments: Breakdown['adjustments'] = [];
  const apply = (kind: Breakdown['adjustments'][number]['kind'], percent: Prisma.Decimal | null, sign: 1 | -1) => {
    if (percent === null) return;
    const amount = percentOf(running, percent).times(sign);
    adjustments.push({ kind, percent, amount });
    running = running.plus(amount);
  };
  apply('quantity_discount', input.tier, -1);
  apply('customer_group', input.groupPercent, 1);
  apply('delivery_speed', input.speedPercent, 1);

  const unitPrice = running.toDecimalPlaces(CENTS, Prisma.Decimal.ROUND_HALF_UP);
  const total = unitPrice.times(input.quantity);
  if (total.abs().greaterThanOrEqualTo(PRICE_LIMIT)) {
    return { accepted: false, reasons: [{ code: 'price_too_large', message: 'The total is too large to quote' }] };
  }
  return {
    accepted: true,
    breakdown: {
      steps,
      costPerPiece,
      overhead: input.overheadPerPiece,
      minSizeSurcharge,
      margin: { percent: input.marginPercent, amount: marginAmount },
      priceBeforeAdjustments,
      adjustments,
      unitPriceExact: running,
      unitPrice,
      total,
    },
  };
}
