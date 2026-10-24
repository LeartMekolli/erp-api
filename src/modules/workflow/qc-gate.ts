import { Prisma } from '../../generated/prisma/client';
import type { ChecklistItem, StepConfig } from './workflow-config';

// The QC gate (Workflow/QC spec, goal 5): what a move must bring at a step before any piece moves.

export const MOVE_KINDS = ['pass', 'fail', 'correction'] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/** The longest text answer, note, comment or reason. */
export const MAX_TEXT = 2_000;

export interface MoveAnswer {
  item: string;
  /** A choice's option key, a decimal string, text, or a boolean for a yes/no question. */
  value: string | boolean;
  note?: string;
}

export interface MoveInput {
  kind: MoveKind;
  answers?: MoveAnswer[];
  defect_id?: string;
  comment?: string;
  photo_file_version_ids?: string[];
}

/** One reason a move is refused; `path` is a checklist item key, `photos`, `comment`, `defect_id` or `answers`. */
export interface MoveProblem {
  path: string;
  message: string;
}

export type GateStep = Pick<StepConfig, 'checklist' | 'defects' | 'pass' | 'fail'>;

const DECIMAL = /^-?\d{1,12}(\.\d{1,6})?$/;

/** Whether an answer passes its item's check; null when it isn't an answer to that item at all. */
export function judge(item: ChecklistItem, value: string | boolean): boolean | null {
  switch (item.kind) {
    case 'choice': {
      const option = typeof value === 'string' ? item.options.find((candidate) => candidate.key === value) : undefined;
      return option ? option.passing : null;
    }
    case 'yes_no':
      return typeof value === 'boolean' ? value === item.passing_answer : null;
    case 'number': {
      if (typeof value !== 'string' || !DECIMAL.test(value)) {
        return null;
      }
      const measured = new Prisma.Decimal(value);
      return (item.min === null || measured.gte(item.min)) && (item.max === null || measured.lte(item.max));
    }
    case 'text':
      return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT ? true : null;
  }
}

/**
 * Everything wrong with a move at a step, or nothing. A pass needs every required answer, each passing, and
 * the step's pass evidence; a fail needs a defect the step allows and its fail evidence, and records answers
 * as given; a correction needs only a comment.
 */
export function checkMove(step: GateStep, move: MoveInput): MoveProblem[] {
  const problems: MoveProblem[] = [];
  const answers = move.answers ?? [];
  const hasComment = (move.comment ?? '').trim().length > 0;

  if (move.kind === 'correction') {
    if (answers.length > 0) {
      problems.push({ path: 'answers', message: 'A correction inspects nothing, so it takes no answers' });
    }
    if (!hasComment) {
      problems.push({ path: 'comment', message: 'A correction needs a comment saying why' });
    }
    return problems;
  }

  const answered = new Set<string>();
  for (const answer of answers) {
    const item = step.checklist.find((candidate) => candidate.key === answer.item);
    if (!item) {
      problems.push({ path: answer.item, message: `${answer.item} is not on this step's checklist` });
      continue;
    }
    if (answered.has(item.key)) {
      problems.push({ path: item.key, message: `${item.label} is answered more than once` });
      continue;
    }
    answered.add(item.key);
    const verdict = judge(item, answer.value);
    if (verdict === null) {
      problems.push({ path: item.key, message: `${String(answer.value)} is not an answer to ${item.label}` });
    } else if (!verdict && move.kind === 'pass') {
      problems.push({ path: item.key, message: `${item.label} does not pass its check` });
    }
  }

  if (move.kind === 'pass') {
    for (const item of step.checklist) {
      if (item.required && !answered.has(item.key)) {
        problems.push({ path: item.key, message: `${item.label} must be answered to pass` });
      }
    }
  } else if (move.defect_id === undefined) {
    problems.push({ path: 'defect_id', message: 'A fail names the defect found' });
  } else if (!step.defects.some((defect) => defect.defect_id === move.defect_id)) {
    problems.push({ path: 'defect_id', message: 'This defect is not one this step records' });
  }

  const evidence = move.kind === 'pass' ? step.pass : step.fail;
  if ((move.photo_file_version_ids ?? []).length < evidence.min_photos) {
    problems.push({ path: 'photos', message: `A ${move.kind} here needs at least ${evidence.min_photos} photo(s)` });
  }
  if (evidence.comment_required && !hasComment) {
    problems.push({ path: 'comment', message: `A ${move.kind} here needs a comment` });
  }
  return problems;
}
