import { Prisma } from '../../generated/prisma/client';
import type { ResolvedPrice } from '../catalog/material-price';
import type { ScalableMeasure } from '../catalog/scaling';
import { SEEDED_UNITS } from '../catalog/units';
import type { Block } from './blocks';
import { costStep } from './step-cost';
import type { PricedMaterial, StepCost } from './step-cost';

const D = (value: string) => new Prisma.Decimal(value);
const unit = (key: string) => SEEDED_UNITS.find((candidate) => candidate.key === key)!;
const price = (unitPrice: string, perUnit: string): ResolvedPrice => ({
  unitPrice: D(unitPrice),
  currency: 'EUR',
  perUnit,
  source: 'manual',
  asOf: null,
  stale: false,
});

const silver: PricedMaterial = {
  id: 'm-silver',
  key: 'silver_925',
  densityGCm3: D('10.36'),
  pricedUnit: unit('g'),
  price: price('0.85', 'g'),
};
const resin: PricedMaterial = {
  id: 'm-resin',
  key: 'standard_resin',
  densityGCm3: null,
  pricedUnit: unit('ml'),
  price: price('0.12', 'ml'),
};

// The 10 mm cube at 1.5×.
const cube: ScalableMeasure[] = [
  { type: 'volume', value: D('3375'), unit: 'mm3' },
  { type: 'surface_area', value: D('1350'), unit: 'mm2' },
];

function cost(
  blocks: Block[],
  options: { quantity?: number; failurePercent?: string; measures?: ScalableMeasure[]; configuration?: PricedMaterial } = {},
) {
  return costStep({
    blocks,
    failurePercent: D(options.failurePercent ?? '0'),
    quantity: options.quantity ?? 1,
    measures: options.measures ?? cube,
    units: [...SEEDED_UNITS],
    materials: new Map([
      ['configuration', options.configuration ?? silver],
      ['m-resin', resin],
    ]),
  });
}

function priced(result: ReturnType<typeof costStep>): StepCost {
  if ('code' in result) {
    throw new Error(`refused: ${result.code} ${result.message}`);
  }
  return result;
}

/** The breakdown with amounts as strings, so values compare rather than Decimal internals. */
const shown = (result: StepCost) => result.blocks.map((block) => ({ ...block, amount: block.amount.toFixed() }));

const silverByWeight: Block = { kind: 'material', source: { configuration: true }, basis: 'weight', loss_percent: '5' };

describe('costStep', () => {
  it('prices the material by weight: volume × density, in the priced unit, plus loss', () => {
    const result = priced(cost([silverByWeight]));
    // 3.375 cm³ × 10.36 g/cm³ = 34.965 g; × 0.85 = 29.72025; + 5 % = 31.2062625.
    expect(shown(result)).toEqual([{ kind: 'material', quantity: '34.965', unit: 'g', rate: '0.85', amount: '31.2062625' }]);
    expect(result.cost.toFixed()).toBe('31.2062625');
  });

  it("prices a fixed material by volume in its own priced unit, whatever the configuration's material", () => {
    const result = priced(cost([{ kind: 'material', source: { material_id: 'm-resin' }, basis: 'volume', loss_percent: '0' }]));
    // 3375 mm³ = 3.375 ml × 0.12.
    expect(shown(result)).toEqual([{ kind: 'material', quantity: '3.375', unit: 'ml', rate: '0.12', amount: '0.405' }]);
  });

  it('prices labour as base minutes plus minutes per unit of a measure, at an hourly rate', () => {
    const result = priced(
      cost([{ kind: 'labour', base_minutes: '5', per: { measure: 'surface_area', unit: 'cm2', minutes: '1' }, hourly_rate: '30' }]),
    );
    // 1350 mm² = 13.5 cm²; 5 + 13.5 = 18.5 minutes at 30/h.
    expect(shown(result)).toEqual([{ kind: 'labour', quantity: '18.5', unit: 'min', rate: '30', amount: '9.25' }]);
  });

  it('prices a rate per measure and a fixed amount per piece', () => {
    const result = priced(
      cost([
        { kind: 'per_measure', measure: 'surface_area', unit: 'cm2', rate: '0.4' },
        { kind: 'fixed', amount: '2.5' },
      ]),
    );
    expect(result.blocks.map((block) => block.amount.toFixed())).toEqual(['5.4', '2.5']);
    expect(result.cost.toFixed()).toBe('7.9');
  });

  describe('batches and setup, shared over the quantity', () => {
    const tree: Block = {
      kind: 'batch',
      size: 8,
      cost_per_batch: '40',
      material: { source: { configuration: true }, amount: '20', unit: 'g' },
    };

    it('charges one piece a whole batch: 40 plus 20 g of silver', () => {
      expect(priced(cost([tree], { quantity: 1 })).cost.toFixed()).toBe('57');
    });

    it('spreads 3 batches over 20 pieces', () => {
      const result = priced(cost([tree], { quantity: 20 }));
      // ceil(20 / 8) = 3 batches × 57 = 171, over 20 pieces.
      expect(result.cost.toFixed()).toBe('8.55');
      // The batch's material shows apart from its cost, so the summary can group it as material.
      expect(result.blocks.map((block) => [block.kind, block.amount.toFixed()])).toEqual([
        ['batch', '6'],
        ['batch_material', '2.55'],
      ]);
    });

    it('spreads the setup over the quantity', () => {
      expect(priced(cost([{ kind: 'setup', amount: '15' }], { quantity: 20 })).cost.toFixed()).toBe('0.75');
    });
  });

  it('adds the failure allowance on the whole step cost', () => {
    const result = priced(cost([silverByWeight, { kind: 'setup', amount: '15' }], { failurePercent: '3' }));
    expect(result.subtotal.toFixed()).toBe('46.2062625');
    expect(result.failure.toFixed()).toBe('1.386187875');
    expect(result.cost.toFixed()).toBe('47.592450375');
  });

  describe('refusals', () => {
    it('refuses a measure the design lacks', () => {
      const result = cost([{ kind: 'per_measure', measure: 'surface_area', unit: 'cm2', rate: '0.4' }], {
        measures: [{ type: 'volume', value: D('3375'), unit: 'mm3' }],
      });
      expect(result).toEqual({ code: 'measure_missing', message: expect.stringContaining('surface_area') });
    });

    it('refuses weight for a material without density', () => {
      const result = cost([silverByWeight], { configuration: { ...silver, densityGCm3: null } });
      expect(result).toEqual({ code: 'density_missing', message: expect.stringContaining('silver_925') });
    });

    it("refuses a configuration material whose priced unit does not fit the block's basis", () => {
      const perPiece: PricedMaterial = { ...silver, pricedUnit: unit('piece'), price: price('3', 'piece') };
      const result = cost([silverByWeight], { configuration: perPiece });
      expect(result).toEqual({ code: 'unit_mismatch', message: expect.stringContaining('silver_925') });
    });
  });
});
