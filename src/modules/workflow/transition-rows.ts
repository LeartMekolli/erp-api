import type { Prisma } from '../../generated/prisma/client';
import type { TransitionResponse } from './work-order-response';
import type { StepConfig } from './workflow-config';

// How a transition row is read and shown, shared by the pieces' history and the list of a line's moves.

export const stepRef = { select: { id: true, key: true, name: true } } as const;
export const nameRef = { select: { id: true, name: true } } as const;

export const transitionInclude = {
  // With its config, to name the answers: a version's steps are never changed, so it is what staff answered.
  fromStep: { select: { id: true, key: true, name: true, config: true } },
  toStep: stepRef,
  defect: stepRef,
  actor: nameRef,
  partner: nameRef,
  answers: { orderBy: { id: 'asc' } },
  photos: { orderBy: { id: 'asc' }, include: { fileVersion: { select: { fileId: true } } } },
} as const satisfies Prisma.TransitionInclude;

type TransitionRow = Prisma.TransitionGetPayload<{ include: typeof transitionInclude }>;

/**
 * An answer with the names the step gave its item and, for a choice, the chosen option. An item no longer
 * on the step is named by its key.
 */
export function readableAnswer(
  answer: TransitionRow['answers'][number],
  checklist: StepConfig['checklist'] | undefined,
): TransitionResponse['answers'][number] {
  const item = checklist?.find((one) => one.key === answer.itemKey);
  const option = item?.kind === 'choice' ? item.options.find((one) => one.key === answer.value) : undefined;
  return {
    item: answer.itemKey,
    label: item?.label ?? answer.itemKey,
    value: answer.value,
    value_label: option?.label ?? null,
    note: answer.note,
    passing: answer.passing,
  };
}

export function toTransition(row: TransitionRow): TransitionResponse {
  const checklist = row.fromStep ? (row.fromStep.config as StepConfig).checklist : undefined;
  return {
    id: row.id,
    move_id: row.moveId,
    kind: row.kind as TransitionResponse['kind'],
    outcome: row.outcome as TransitionResponse['outcome'],
    from_step: row.fromStep ? { id: row.fromStep.id, key: row.fromStep.key, name: row.fromStep.name } : null,
    to_step: row.toStep,
    defect: row.defect,
    override_reason: row.overrideReason,
    comment: row.comment,
    answers: row.answers.map((answer) => readableAnswer(answer, checklist)),
    photo_file_version_ids: row.photos.map((photo) => photo.fileVersionId),
    photos: row.photos.map((photo) => ({ file_id: photo.fileVersion.fileId, file_version_id: photo.fileVersionId })),
    actor: row.actor,
    partner: row.partner,
    inspected: row.inspected,
    created_at: row.createdAt.toISOString(),
  };
}
