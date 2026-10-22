import { Prisma } from '../../generated/prisma/client';
import type { ResolvedPrice } from '../catalog/material-price';
import type { ScalableMeasure } from '../catalog/scaling';
import { SEEDED_UNITS, convert } from '../catalog/units';
import type { UnitDef } from '../catalog/units';
import type { MeasureType } from '../files/measurers';
import type { Block, MaterialBasis, MaterialSource } from './blocks';

/** Intermediate amounts keep 10 places (Pricing plan); only the price per piece is rounded to cents. */
const PLACES = 10;
const round = (value: Prisma.Decimal) => value.toDecimalPlaces(PLACES, Prisma.Decimal.ROUND_HALF_UP);
const shown = (value: Prisma.Decimal) => round(value).toFixed();

const GRAM = SEEDED_UNITS.find((unit) => unit.key === 'g')!;
const CUBIC_CM = SEEDED_UNITS.find((unit) => unit.key === 'cm3')!;
const PIECE = SEEDED_UNITS.find((unit) => unit.key === 'piece')!;

/** What a step needs to know about a material: the configuration's, or one named on the step. */
export interface MaterialFacts {
  key: string;
  densityGCm3: Prisma.Decimal | null;
  pricedUnit: UnitDef;
}

export interface PricedMaterial extends MaterialFacts {
  id: string;
  price: ResolvedPrice;
}

export interface StepRefusal {
  code: 'measure_missing' | 'density_missing' | 'unit_mismatch';
  message: string;
}

export interface StepCostLine {
  kind: Block['kind'] | 'batch_material';
  quantity?: string;
  unit?: string;
  rate?: string;
  amount: Prisma.Decimal;
}

/** One step's cost per piece: its blocks, their sum, the failure allowance on it, and the total. */
export interface StepCost {
  blocks: StepCostLine[];
  subtotal: Prisma.Decimal;
  failure: Prisma.Decimal;
  cost: Prisma.Decimal;
}

const BASIS_DIMENSION = { weight: 'mass', volume: 'volume', piece: 'count' } as const;

/**
 * Whether a material can be charged by `need`: a basis (weight needs a mass priced unit and a
 * density, volume a volume unit, piece a count unit), or an amount in a unit (mass and volume
 * convert into each other through the density). Used on save for fixed materials, and on quote
 * for the configuration's.
 */
export function materialFit(material: MaterialFacts, need: MaterialBasis | UnitDef): StepRefusal | null {
  const priced = material.pricedUnit.dimension;
  const mismatch = (what: string): StepRefusal => ({
    code: 'unit_mismatch',
    message: `Material ${material.key} is priced per ${material.pricedUnit.key}, which cannot be charged ${what}`,
  });
  const noDensity: StepRefusal = { code: 'density_missing', message: `Material ${material.key} has no density` };

  if (typeof need === 'string') {
    if (priced !== BASIS_DIMENSION[need]) return mismatch(`by ${need}`);
    return need === 'weight' && !material.densityGCm3 ? noDensity : null;
  }
  if (need.dimension === priced) return null;
  const massAndVolume = new Set([need.dimension, priced]);
  if (massAndVolume.has('mass') && massAndVolume.has('volume')) {
    return material.densityGCm3 ? null : noDensity;
  }
  return mismatch(`in ${need.key}`);
}

/** `value` in `from`, as the material's priced unit; mass and volume go through the density. */
function inPricedUnit(value: Prisma.Decimal, from: UnitDef, material: MaterialFacts): Prisma.Decimal {
  const to = material.pricedUnit;
  if (from.dimension === to.dimension) return convert(value, from, to);
  const density = material.densityGCm3!;
  if (from.dimension === 'volume') {
    return convert(convert(value, from, CUBIC_CM).times(density), GRAM, to);
  }
  return convert(convert(value, from, GRAM).dividedBy(density), CUBIC_CM, to);
}

/**
 * The cost of one step per piece for `quantity` pieces, from its building blocks (Pricing spec,
 * Q3, Q4): setup is shared by the quantity; batches are the quantity over the batch size, rounded
 * up, and their cost and lost material are shared by the actual quantity; the failure allowance
 * applies to the whole. `materials` holds the configuration's material under `'configuration'` and
 * every material named on a block under its id.
 */
export function costStep(input: {
  blocks: Block[];
  failurePercent: Prisma.Decimal;
  quantity: number;
  measures: ScalableMeasure[];
  units: UnitDef[];
  materials: Map<string, PricedMaterial>;
}): StepCost | StepRefusal {
  const unit = (key: string): UnitDef => {
    const found = input.units.find((candidate) => candidate.key === key);
    if (!found) throw new Error(`Unknown unit ${key}`);
    return found;
  };
  const material = (source: MaterialSource): PricedMaterial => {
    const key = 'configuration' in source ? 'configuration' : source.material_id;
    const found = input.materials.get(key);
    if (!found) throw new Error(`Material ${key} was not loaded`);
    return found;
  };
  /** The measure's value in `unitKey`, or why it has none. */
  const measure = (type: MeasureType, unitKey: string): Prisma.Decimal | StepRefusal => {
    const found = input.measures.find((candidate) => candidate.type === type);
    if (!found) return { code: 'measure_missing', message: `The design has no ${type} measure` };
    return convert(found.value, unit(found.unit), unit(unitKey));
  };
  const quantity = new Prisma.Decimal(input.quantity);

  const lines: StepCostLine[] = [];
  for (const block of input.blocks) {
    switch (block.kind) {
      case 'material': {
        const used = material(block.source);
        const refusal = materialFit(used, block.basis);
        if (refusal) return refusal;
        let amount: Prisma.Decimal;
        if (block.basis === 'piece') {
          amount = convert(new Prisma.Decimal(1), PIECE, used.pricedUnit);
        } else {
          const volume = measure('volume', 'mm3');
          if (!(volume instanceof Prisma.Decimal)) return volume;
          amount = inPricedUnit(volume, unit('mm3'), used);
        }
        const loss = new Prisma.Decimal(block.loss_percent).dividedBy(100).plus(1);
        lines.push({
          kind: 'material',
          quantity: shown(amount),
          unit: used.pricedUnit.key,
          rate: used.price.unitPrice.toFixed(),
          amount: round(amount.times(used.price.unitPrice).times(loss)),
        });
        break;
      }
      case 'machine_time':
      case 'labour': {
        let minutes = new Prisma.Decimal(block.base_minutes);
        if (block.per) {
          const value = measure(block.per.measure, block.per.unit);
          if (!(value instanceof Prisma.Decimal)) return value;
          minutes = minutes.plus(value.times(block.per.minutes));
        }
        lines.push({
          kind: block.kind,
          quantity: shown(minutes),
          unit: 'min',
          rate: block.hourly_rate,
          amount: round(minutes.times(block.hourly_rate).dividedBy(60)),
        });
        break;
      }
      case 'per_measure': {
        const value = measure(block.measure, block.unit);
        if (!(value instanceof Prisma.Decimal)) return value;
        lines.push({ kind: 'per_measure', quantity: shown(value), unit: block.unit, rate: block.rate, amount: round(value.times(block.rate)) });
        break;
      }
      case 'fixed':
        lines.push({ kind: 'fixed', amount: round(new Prisma.Decimal(block.amount)) });
        break;
      case 'setup':
        lines.push({ kind: 'setup', rate: block.amount, amount: round(new Prisma.Decimal(block.amount).dividedBy(quantity)) });
        break;
      case 'batch': {
        const batches = Math.ceil(input.quantity / block.size);
        lines.push({
          kind: 'batch',
          quantity: String(batches),
          unit: 'batch',
          rate: block.cost_per_batch,
          amount: round(new Prisma.Decimal(block.cost_per_batch).times(batches).dividedBy(quantity)),
        });
        if (block.material) {
          const used = material(block.material.source);
          const lostIn = unit(block.material.unit);
          const refusal = materialFit(used, lostIn);
          if (refusal) return refusal;
          const perPiece = inPricedUnit(new Prisma.Decimal(block.material.amount), lostIn, used).times(batches).dividedBy(quantity);
          lines.push({
            kind: 'batch_material',
            quantity: shown(perPiece),
            unit: used.pricedUnit.key,
            rate: used.price.unitPrice.toFixed(),
            amount: round(perPiece.times(used.price.unitPrice)),
          });
        }
        break;
      }
    }
  }

  const subtotal = lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0));
  const failure = round(subtotal.times(input.failurePercent).dividedBy(100));
  return { blocks: lines, subtotal, failure, cost: subtotal.plus(failure) };
}
