import { Prisma } from '../../generated/prisma/client';
import type { Breakdown } from './engine';
import type { SummaryGroup } from './pricing-response';
import type { StepCostLine } from './step-cost';
import { customerSummary } from './summary';

const D = (value: string) => new Prisma.Decimal(value);
const zero = D('0');

/** A priced step whose blocks cost the given amounts. */
function step(key: string, summaryGroup: SummaryGroup, lines: [StepCostLine['kind'], string][], failure = '0'): Breakdown['steps'][number] {
  const blocks = lines.map(([kind, amount]) => ({ kind, amount: D(amount) }));
  const subtotal = blocks.reduce((sum, block) => sum.plus(block.amount), zero);
  return { key, name: key, summaryGroup, cost: { blocks, subtotal, failure: D(failure), cost: subtotal.plus(failure) } };
}

function breakdown(
  steps: Breakdown['steps'],
  unitPrice: string,
  adjustments: Breakdown['adjustments'] = [],
): Breakdown {
  return {
    steps,
    costPerPiece: zero,
    overhead: zero,
    minSizeSurcharge: zero,
    margin: { percent: zero, amount: zero },
    priceBeforeAdjustments: zero,
    adjustments,
    unitPriceExact: D(unitPrice),
    unitPrice: D(unitPrice),
    total: D(unitPrice),
  };
}

const shown = (summary: ReturnType<typeof customerSummary>) => summary.lines.map((line) => [line.label, line.amount.toFixed(2)]);
const sum = (summary: ReturnType<typeof customerSummary>) =>
  summary.lines.reduce((total, line) => total.plus(line.amount), zero).toFixed(2);

// Material 20 (the casting's metal and the tree's lost metal), making 25, finishing 5. The failure
// allowance is spread like margin, so it does not move the split.
const castSteps = [
  step('casting', 'making', [
    ['material', '15'],
    ['batch_material', '5'],
    ['batch', '10'],
    ['labour', '15'],
  ], '5'),
  step('polishing', 'finishing', [['labour', '5']]),
];

// The engine's worked example: 50 cost, overhead 2, margin 40 %, tier 5 %, group -10 %, speed 20 %.
const workedAdjustments: Breakdown['adjustments'] = [
  { kind: 'quantity_discount', percent: D('5'), amount: D('-3.64') },
  { kind: 'customer_group', percent: D('-10'), amount: D('-6.916') },
  { kind: 'delivery_speed', percent: D('20'), amount: D('12.4488') },
];

describe('customerSummary', () => {
  it('splits the price over material, making and finishing, with discount and speed lines, adding up exactly', () => {
    const summary = customerSummary(breakdown(castSteps, '74.69', workedAdjustments));
    expect(shown(summary)).toEqual([
      ['material', '29.12'],
      ['making', '36.40'],
      ['finishing', '7.28'],
      ['quantity_discount', '-3.64'],
      ['your_discount', '-6.92'],
      ['delivery_speed', '12.45'],
    ]);
    expect(sum(summary)).toBe('74.69');
    expect(summary.unitPrice.toFixed(2)).toBe('74.69');
  });

  it('folds a positive customer group into the base, with no line of its own', () => {
    const summary = customerSummary(
      breakdown(castSteps, '80.08', [{ kind: 'customer_group', percent: D('10'), amount: D('7.28') }]),
    );
    expect(summary.lines.map((line) => line.label)).toEqual(['material', 'making', 'finishing']);
    expect(sum(summary)).toBe('80.08');
  });

  it('gives the rounding difference to the largest line, so the lines always add up', () => {
    const thirds = [step('a', 'making', [['material', '1']]), step('b', 'making', [['labour', '1']]), step('c', 'finishing', [['fixed', '1']])];
    // 10 / 3 each rounds to 3.33, a cent short; the largest line (the first, on a tie) takes it.
    const summary = customerSummary(breakdown(thirds, '10.00'));
    expect(shown(summary)).toEqual([
      ['material', '3.34'],
      ['making', '3.33'],
      ['finishing', '3.33'],
    ]);
    expect(sum(summary)).toBe('10.00');
  });

  it('drops lines that come to nothing', () => {
    const summary = customerSummary(
      breakdown([step('print', 'making', [['labour', '4']])], '4.00', [{ kind: 'delivery_speed', percent: zero, amount: zero }]),
    );
    expect(shown(summary)).toEqual([['making', '4.00']]);
  });

  it('puts the whole price on making when no step has a cost', () => {
    const summary = customerSummary(breakdown([], '2.00'));
    expect(shown(summary)).toEqual([['making', '2.00']]);
  });

  it('tells the customer nothing else: only labels and amounts', () => {
    const summary = customerSummary(breakdown(castSteps, '74.69', workedAdjustments));
    expect(Object.keys(summary).sort()).toEqual(['lines', 'unitPrice']);
    for (const line of summary.lines) {
      expect(Object.keys(line).sort()).toEqual(['amount', 'label']);
    }
  });
});
