/**
 * Where a piece stands for the partner holding its job (spec, part 3): at one of the partner's steps; at a
 * workspace step with a partner step still to come on its path; or past the last partner step. A workflow
 * mixes partner and workspace steps freely, so only the piece's own path decides. The jobs list asks the
 * same question in SQL (`openForPartner`); the two must agree.
 */

export const PARTNER_STAGES = ['yours', 'not_yet', 'done'] as const;
export type PartnerStage = (typeof PARTNER_STAGES)[number];

/** `path` is the piece's path in order (`pathFor`); null unless the piece is active. */
export function stageOf(
  path: { id: string; doneBy: string }[],
  piece: { status: string; currentStepId: string | null },
): PartnerStage | null {
  if (piece.status !== 'active' || piece.currentStepId === null) {
    return null;
  }
  const at = path.findIndex((step) => step.id === piece.currentStepId);
  if (path[at]?.doneBy === 'partner') {
    return 'yours';
  }
  return path.slice(at + 1).some((step) => step.doneBy === 'partner') ? 'not_yet' : 'done';
}
