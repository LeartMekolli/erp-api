/**
 * Who does each workflow step, and where a partner is owed (Partners spec, goals 7 and 14). A step is
 * the partner's unless the workspace does it in-house; capabilities, capacity and partner moves cover
 * only the partner's steps.
 */

export const DONE_BY = ['partner', 'workspace'] as const;
export type DoneBy = (typeof DONE_BY)[number];

/**
 * The step whose pass makes the partner owed for a piece: the one the version names, else the last
 * partner step by position, else none, when the workspace does every step.
 */
export function payoutStepId(
  steps: { id: string; position: number; doneBy: string }[],
  explicit: string | null,
): string | null {
  if (explicit !== null) return explicit;
  const partnerSteps = steps.filter((step) => step.doneBy === 'partner').sort((a, b) => a.position - b.position);
  return partnerSteps.at(-1)?.id ?? null;
}

/** The step types a partner must be able to do for this version's work. */
export function partnerStepTypeIds(steps: { stepTypeId: string; doneBy: string }[]): Set<string> {
  return new Set(steps.filter((step) => step.doneBy === 'partner').map((step) => step.stepTypeId));
}
