import { Prisma } from '../../generated/prisma/client';
import type { ScalableMeasure } from '../catalog/scaling';
import { SEEDED_UNITS } from '../catalog/units';
import type { Block } from './blocks';
import type { ChainStep } from './chain';
import { priceConfiguration, tierFor } from './engine';
import type { Breakdown, EngineInput, EngineResult } from './engine';

const D = (value: string) => new Prisma.Decimal(value);
const step = (key: string, position: number, summaryGroup: ChainStep['summaryGroup'] = 'making'): ChainStep => ({
  id: `st-${key}`,
  key,
  name: key,
  position,
  summaryGroup,
});
const fixed = (amount: string): { failurePercent: Prisma.Decimal; blocks: Block[] } => ({
  failurePercent: D('0'),
  blocks: [{ kind: 'fixed', amount }],
});

const cube: ScalableMeasure[] = [
  { type: 'volume', value: D('3375'), unit: 'mm3' },
  { type: 'bounding_box_z', value: D('15'), unit: 'mm' },
];

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    quantity: 1,
    steps: [{ step: step('casting', 30), price: fixed('50') }],
    measures: cube,
    units: [...SEEDED_UNITS],
    materials: new Map(),
    overheadPerPiece: D('0'),
    minSize: [],
    marginPercent: D('0'),
    tier: null,
    groupPercent: null,
    speedPercent: null,
    ...overrides,
  };
}

function priced(result: EngineResult): Breakdown {
  if (!result.accepted) {
    throw new Error(`refused: ${JSON.stringify(result.reasons)}`);
  }
  return result.breakdown;
}

describe('priceConfiguration', () => {
  it('goes from step costs to overhead, margin, then tier, group and speed, each on the one before', () => {
    const breakdown = priced(
      priceConfiguration(
        input({
          quantity: 10,
          overheadPerPiece: D('2'),
          marginPercent: D('40'),
          tier: D('5'),
          groupPercent: D('-10'),
          speedPercent: D('20'),
        }),
      ),
    );
    expect(breakdown.steps.map((line) => [line.key, line.cost.cost.toFixed()])).toEqual([['casting', '50']]);
    expect(breakdown.costPerPiece.toFixed()).toBe('50');
    expect(breakdown.overhead.toFixed()).toBe('2');
    // (50 + 2) × 1.4.
    expect(breakdown.margin.amount.toFixed()).toBe('20.8');
    expect(breakdown.priceBeforeAdjustments.toFixed()).toBe('72.8');
    expect(breakdown.adjustments.map((line) => [line.kind, line.percent.toFixed(), line.amount.toFixed()])).toEqual([
      ['quantity_discount', '5', '-3.64'],
      ['customer_group', '-10', '-6.916'],
      ['delivery_speed', '20', '12.4488'],
    ]);
    expect(breakdown.unitPriceExact.toFixed()).toBe('74.6928');
    expect(breakdown.unitPrice.toFixed(2)).toBe('74.69');
    expect(breakdown.total.toFixed(2)).toBe('746.90');
  });

  it('adds up the steps in chain order', () => {
    const breakdown = priced(
      priceConfiguration(
        input({
          steps: [
            { step: step('polishing', 40, 'finishing'), price: fixed('5') },
            { step: step('casting', 30), price: fixed('50') },
          ],
        }),
      ),
    );
    expect(breakdown.steps.map((line) => [line.key, line.summaryGroup])).toEqual([
      ['casting', 'making'],
      ['polishing', 'finishing'],
    ]);
    expect(breakdown.costPerPiece.toFixed()).toBe('55');
  });

  it('reports every step it cannot price at once', () => {
    const result = priceConfiguration(
      input({
        steps: [
          { step: step('casting', 30), price: null },
          {
            step: step('plating', 50, 'finishing'),
            price: { failurePercent: D('0'), blocks: [{ kind: 'per_measure', measure: 'surface_area', unit: 'cm2', rate: '0.4' }] },
          },
        ],
      }),
    );
    expect(result).toEqual({
      accepted: false,
      reasons: [
        { code: 'step_price_missing', step: 'casting', message: expect.stringContaining('casting') },
        { code: 'measure_missing', step: 'plating', message: expect.stringContaining('surface_area') },
      ],
    });
  });

  it('adds the highest matching minimum-size surcharge once, before the margin', () => {
    const breakdown = priced(
      priceConfiguration(
        input({
          marginPercent: D('10'),
          minSize: [
            { measure: 'bounding_box_z', below: D('20'), amount: D('3') },
            { measure: 'volume', below: D('5000'), amount: D('5') },
            // Not matched: the design is not below it.
            { measure: 'volume', below: D('1000'), amount: D('9') },
            // Not matched: the design has no surface area measure.
            { measure: 'surface_area', below: D('99999'), amount: D('7') },
          ],
        }),
      ),
    );
    expect(breakdown.minSizeSurcharge.toFixed()).toBe('5');
    // (50 + 5) × 1.1.
    expect(breakdown.priceBeforeAdjustments.toFixed()).toBe('60.5');
  });

  it('has no adjustment rows when no tier is reached and no group or speed is given', () => {
    const breakdown = priced(priceConfiguration(input()));
    expect(breakdown.adjustments).toEqual([]);
    expect(breakdown.unitPrice.toFixed(2)).toBe('50.00');
  });

  it('rounds the price per piece once, half up, and multiplies the rounded price', () => {
    const breakdown = priced(priceConfiguration(input({ quantity: 3, steps: [{ step: step('casting', 30), price: fixed('10.005') }] })));
    expect(breakdown.unitPriceExact.toFixed()).toBe('10.005');
    expect(breakdown.unitPrice.toFixed(2)).toBe('10.01');
    expect(breakdown.total.toFixed(2)).toBe('30.03');
  });

  it('refuses a configuration with no steps, whose material would never be priced', () => {
    expect(priceConfiguration(input({ steps: [], overheadPerPiece: D('2') }))).toEqual({
      accepted: false,
      reasons: [{ code: 'no_steps', message: expect.any(String) }],
    });
  });

  it('refuses a total too large to keep, rather than failing to save it', () => {
    const result = priceConfiguration(
      input({ quantity: 1_000_000, marginPercent: D('1000'), steps: [{ step: step('casting', 30), price: fixed('999999999999') }] }),
    );
    expect(result).toEqual({ accepted: false, reasons: [{ code: 'price_too_large', message: expect.any(String) }] });
  });

  it('keeps intermediate amounts to 10 places', () => {
    const breakdown = priced(priceConfiguration(input({ marginPercent: D('33.3333'), steps: [{ step: step('casting', 30), price: fixed('0.000001') }] })));
    expect(breakdown.margin.amount.decimalPlaces()).toBeLessThanOrEqual(10);
    expect(breakdown.priceBeforeAdjustments.decimalPlaces()).toBeLessThanOrEqual(10);
  });
});

describe('tierFor', () => {
  const tiers = [
    { minQuantity: 10, percent: D('5') },
    { minQuantity: 50, percent: D('10') },
  ];

  it('takes the highest tier reached, whatever the list order', () => {
    expect(tierFor(tiers, 9)).toBeNull();
    expect(tierFor(tiers, 10)?.toFixed()).toBe('5');
    expect(tierFor(tiers, 49)?.toFixed()).toBe('5');
    expect(tierFor([...tiers].reverse(), 50)?.toFixed()).toBe('10');
    expect(tierFor(tiers, 1000)?.toFixed()).toBe('10');
  });
});
