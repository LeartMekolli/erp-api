/**
 * The steps a piece goes through, in position order (F12): a step nobody prices always runs; a priced
 * step runs only when the source's chain includes its step type. Without a chain, every step runs.
 */
export function pathFor(
  steps: { id: string; stepTypeId: string; priced: boolean; position: number }[],
  chainStepTypeIds: string[] | null,
): string[] {
  const chain = chainStepTypeIds ? new Set(chainStepTypeIds) : null;
  return [...steps]
    .sort((a, b) => a.position - b.position)
    .filter((step) => !step.priced || chain === null || chain.has(step.stepTypeId))
    .map((step) => step.id);
}
