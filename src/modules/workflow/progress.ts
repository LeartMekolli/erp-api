import type { CustomerViewResponse, WorkOrderStatus } from './work-order-response';
import type { StepConfig } from './workflow-config';

// Progress is derived from the pieces and their transitions, never stored (D39).

/** The part of a transition progress reads. */
export interface TransitionFacts {
  kind: string;
  outcome: string | null;
  fromStepId: string | null;
}

/**
 * The rework a piece is in, from its history oldest first (B2): the latest rework fail, until the piece
 * passes the step it failed at (or fails there again and continues). Corrections neither open nor close one.
 */
export function inRework(history: TransitionFacts[]): { failedAtStepId: string } | null {
  let open: string | null = null;
  for (const row of history) {
    if (row.kind === 'fail' && row.outcome === 'rework') {
      open = row.fromStepId;
    } else if (open !== null && row.fromStepId === open && (row.kind === 'pass' || (row.kind === 'fail' && row.outcome === 'continue'))) {
      open = null;
    }
  }
  return open === null ? null : { failedAtStepId: open };
}

/** Ready once every live piece (active or finished) is finished and there is one; scrapped and cancelled pieces are gone. */
export function groupReady(pieces: { status: string }[]): boolean {
  const live = pieces.filter((piece) => piece.status === 'active' || piece.status === 'finished');
  return live.length > 0 && live.every((piece) => piece.status === 'finished');
}

export interface GroupProgress {
  pieces: { active: number; finished: number; scrapped: number };
  steps: { key: string; name: string; count: number; in_rework: number }[];
}

/** Active pieces per step of the path, how many of them are in rework, and pieces by status. */
export function groupProgress(
  path: { id: string; key: string; name: string }[],
  pieces: { status: string; currentStepId: string | null; history: TransitionFacts[] }[],
): GroupProgress {
  const count = (status: WorkOrderStatus) => pieces.filter((piece) => piece.status === status).length;
  return {
    pieces: { active: count('active'), finished: count('finished'), scrapped: count('scrapped') },
    steps: path.map((step) => {
      const here = pieces.filter((piece) => piece.status === 'active' && piece.currentStepId === step.id);
      return {
        key: step.key,
        name: step.name,
        count: here.length,
        in_rework: here.filter((piece) => inRework(piece.history) !== null).length,
      };
    }),
  };
}

/** The part of a move a step's quality totals read. */
export interface MoveFacts extends TransitionFacts {
  id: string;
  defectId: string | null;
  inspected: boolean;
}

export interface StepTotals {
  passed: number;
  failed: number;
  /** The passes among `passed` of pieces left out of the step's sample. */
  not_inspected: number;
  defectCounts: Map<string, number>;
  /** The latest inspected pass or fail at the step, by id; an uninspected pass is not a check. */
  latestCheckId: string | null;
}

/**
 * Each step's checks, from every move of a group: passes and fails made at it, moves not pieces, so a
 * piece that fails and then passes counts once in each. Corrections count in neither.
 */
export function stepTotals(stepIds: string[], moves: MoveFacts[]): Map<string, StepTotals> {
  const totals = new Map<string, StepTotals>(
    stepIds.map((stepId) => [stepId, { passed: 0, failed: 0, not_inspected: 0, defectCounts: new Map(), latestCheckId: null }]),
  );
  for (const move of moves) {
    const step = move.fromStepId === null ? undefined : totals.get(move.fromStepId);
    if (!step || (move.kind !== 'pass' && move.kind !== 'fail')) {
      continue;
    }
    if (move.kind === 'pass') {
      step.passed += 1;
      step.not_inspected += move.inspected ? 0 : 1;
    } else {
      step.failed += 1;
      if (move.defectId !== null) {
        step.defectCounts.set(move.defectId, (step.defectCounts.get(move.defectId) ?? 0) + 1);
      }
    }
    if (move.inspected && (step.latestCheckId === null || move.id > step.latestCheckId)) {
      step.latestCheckId = move.id;
    }
  }
  return totals;
}

/**
 * What a customer sees of a group (D19, goal 10): per live piece, the customer name of the visible stage
 * it is at or last passed, and plain flags. Never defects, answers, photos, comments or hidden steps.
 */
export function customerView(
  path: { id: string; customer: StepConfig['customer'] }[],
  quantity: number,
  pieces: { number: number; status: string; currentStepId: string | null; replacesId: string | null; history: TransitionFacts[] }[],
): CustomerViewResponse {
  const stage = (stepId: string | null): string | null => {
    const at = path.findIndex((step) => step.id === stepId);
    for (let index = at; index >= 0; index -= 1) {
      const { customer } = path[index];
      if (customer.visible) {
        return customer.name;
      }
    }
    return null;
  };
  return {
    pieces: pieces
      .filter((piece) => piece.status === 'active' || piece.status === 'finished')
      .sort((a, b) => a.number - b.number)
      .map((piece) => ({
        label: `${piece.number}/${quantity}`,
        stage: piece.status === 'active' ? stage(piece.currentStepId) : null,
        redone: piece.status === 'active' && inRework(piece.history) !== null,
        restarted: piece.status === 'active' && piece.replacesId !== null,
        finished: piece.status === 'finished',
      })),
  };
}
