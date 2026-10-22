import type { SummaryGroup } from './pricing-response';

export interface ChainStep {
  id: string;
  key: string;
  name: string;
  position: number;
  summaryGroup: SummaryGroup;
}

/** What choosing an option value does to the chain. */
export interface StepEffect {
  valueId: string;
  valueKey: string;
  step: ChainStep;
  effect: 'add' | 'remove';
}

export type ChainResult = { steps: ChainStep[] } | { conflict: { step: string; adding: string; removing: string } };

/**
 * The steps a configuration goes through (Pricing spec R4): the base chain (the product's own, else
 * its category's), plus the steps chosen values add, minus those they remove. Adding a step already
 * there or removing one that is not changes nothing; one chosen value adding a step another removes
 * is a conflict (Q5). Ordered by position, then key.
 */
export function resolveChain(input: { base: ChainStep[]; effects: StepEffect[]; chosenValueIds: string[] }): ChainResult {
  const chosen = new Set(input.chosenValueIds);
  const active = input.effects.filter((effect) => chosen.has(effect.valueId));

  for (const adding of active.filter((effect) => effect.effect === 'add')) {
    const removing = active.find((effect) => effect.effect === 'remove' && effect.step.id === adding.step.id);
    if (removing) {
      return { conflict: { step: adding.step.key, adding: adding.valueKey, removing: removing.valueKey } };
    }
  }

  const steps = new Map(input.base.map((step) => [step.id, step]));
  for (const effect of active) {
    if (effect.effect === 'add') {
      steps.set(effect.step.id, effect.step);
    } else {
      steps.delete(effect.step.id);
    }
  }
  return {
    steps: [...steps.values()].sort((a, b) => a.position - b.position || a.key.localeCompare(b.key)),
  };
}
