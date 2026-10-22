import { resolveChain } from './chain';
import type { ChainStep, StepEffect } from './chain';

const step = (key: string, position: number): ChainStep => ({
  id: `st-${key}`,
  key,
  name: key,
  position,
  summaryGroup: 'making',
});
const printPattern = step('print_pattern', 10);
const castingTree = step('casting_tree', 20);
const casting = step('casting', 30);
const polishing = step('polishing', 40);
const plating = step('plating', 50);
const base = [casting, printPattern, polishing, castingTree];

const effects: StepEffect[] = [
  { valueId: 'v-gold', valueKey: 'gold_plated', step: plating, effect: 'add' },
  { valueId: 'v-raw', valueKey: 'raw', step: polishing, effect: 'remove' },
  { valueId: 'v-polished', valueKey: 'polished', step: polishing, effect: 'add' },
  { valueId: 'v-no-plating', valueKey: 'no_plating', step: plating, effect: 'remove' },
];

const keys = (result: ReturnType<typeof resolveChain>) => ('steps' in result ? result.steps.map((s) => s.key) : result);

describe('resolveChain', () => {
  it('orders the base chain by position', () => {
    expect(keys(resolveChain({ base, effects, chosenValueIds: [] }))).toEqual([
      'print_pattern',
      'casting_tree',
      'casting',
      'polishing',
    ]);
  });

  it('adds a step a chosen value adds, in position order', () => {
    expect(keys(resolveChain({ base, effects, chosenValueIds: ['v-gold'] }))).toEqual([
      'print_pattern',
      'casting_tree',
      'casting',
      'polishing',
      'plating',
    ]);
  });

  it('removes a step a chosen value removes', () => {
    expect(keys(resolveChain({ base, effects, chosenValueIds: ['v-raw'] }))).toEqual([
      'print_pattern',
      'casting_tree',
      'casting',
    ]);
  });

  it('ignores adding a step already there, removing one that is not, and effects of values not chosen', () => {
    expect(keys(resolveChain({ base, effects, chosenValueIds: ['v-polished', 'v-no-plating'] }))).toEqual([
      'print_pattern',
      'casting_tree',
      'casting',
      'polishing',
    ]);
  });

  it('refuses a step one chosen value adds and another removes', () => {
    expect(resolveChain({ base, effects, chosenValueIds: ['v-gold', 'v-no-plating'] })).toEqual({
      conflict: { step: 'plating', adding: 'gold_plated', removing: 'no_plating' },
    });
  });

  it('breaks a position tie by key', () => {
    const tied = [step('b_step', 10), step('a_step', 10)];
    expect(keys(resolveChain({ base: tied, effects: [], chosenValueIds: [] }))).toEqual(['a_step', 'b_step']);
  });
});
