import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { newId } from '../../common/ids/uuid';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { TenantAuth } from '../identity/auth-context';
import { keySchema } from '../pricing/decimals';
import type { WorkflowStepRow } from './coverage';
import { pathFor } from './path';
import { MAX_TEXT, MOVE_KINDS, checkMove, judge } from './qc-gate';
import type { GateStep, MoveProblem } from './qc-gate';
import type { MoveResponse, WorkOrderStatus } from './work-order-response';
import { OUTCOMES } from './workflow-config';
import type { Outcome, StepConfig } from './workflow-config';
import { chainOf, pieceInclude, stepsForPath, toWorkOrder } from './work-orders.service';

/** Limits per move (Workflow/QC plan). */
export const MAX_PIECES_PER_MOVE = 1_000;
export const MAX_PHOTOS_PER_MOVE = 20;

/** Photos a move may attach: uploaded, whether or not measuring has finished. */
const ATTACHABLE = ['uploaded', 'measuring', 'measured'];

const unique = (values: string[]) => new Set(values).size === values.length;
const text = z.string().trim().max(MAX_TEXT);

export const moveSchema = z
  .strictObject({
    work_order_ids: z.array(z.uuid()).min(1).max(MAX_PIECES_PER_MOVE).refine(unique, 'a piece must not repeat'),
    kind: z.enum(MOVE_KINDS),
    /** Pass and fail: the step the pieces are at. A piece that has moved on since is a 409. */
    at_step: keySchema.optional(),
    /** Correction: the step of the piece's path to put it at. */
    to_step: keySchema.optional(),
    answers: z
      .array(z.strictObject({ item: keySchema, value: z.union([z.string().max(MAX_TEXT), z.boolean()]), note: text.min(1).optional() }))
      .max(50)
      .optional(),
    defect_id: z.uuid().optional(),
    /** Fail: overrides the defect's default outcome, with `override_reason`. */
    outcome: z.enum(OUTCOMES).optional(),
    /** Fail with rework: overrides the defect's default target, with `override_reason`. */
    rework_to: keySchema.optional(),
    override_reason: text.min(1).optional(),
    comment: text.optional(),
    photo_file_version_ids: z.array(z.uuid()).max(MAX_PHOTOS_PER_MOVE).refine(unique, 'a photo must not repeat').optional(),
  })
  .superRefine((move, context) => {
    const refuse = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message });
    const correction = move.kind === 'correction';
    if (correction && move.to_step === undefined) {
      refuse('to_step', 'a correction names the step to put the pieces at');
    }
    if (correction && move.at_step !== undefined) {
      refuse('at_step', 'a correction names to_step instead');
    }
    if (!correction && move.at_step === undefined) {
      refuse('at_step', 'a pass or fail names the step the pieces are at');
    }
    if (!correction && move.to_step !== undefined) {
      refuse('to_step', 'only a correction names to_step');
    }
    for (const field of ['defect_id', 'outcome', 'rework_to', 'override_reason'] as const) {
      if (move.kind !== 'fail' && move[field] !== undefined) {
        refuse(field, 'only a fail takes this');
      }
    }
  });
export type MoveBody = z.infer<typeof moveSchema>;

/** A correction checks only its comment, so it is gated against a step with no checks. */
const NO_CHECKS: GateStep = {
  checklist: [],
  defects: [],
  pass: { min_photos: 0, comment_required: false },
  fail: { min_photos: 0, comment_required: false },
};

interface Landing {
  stepId: string | null;
  status: WorkOrderStatus;
}

interface ReplacementRow {
  id: string;
  replacesId: string | null;
  currentStepId: string | null;
}

/** The move command (Workflow/QC spec, goals 5 and 6): the only writer of transitions. */
@Injectable()
export class MovesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * With a `scope`, a partner's own people move: every piece must be of a job the partner has
   * accepted (else not found), and every step the move touches must be a partner step (else 409,
   * naming the piece). Each transition records the partner its job is with, when made at a partner
   * step, whoever made it (Partners spec, goal 13 and B5).
   */
  async move(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, body: MoveBody, scope?: { partnerId: string }): Promise<MoveResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const ids = body.work_order_ids;
      // In id order, so two moves sharing pieces can't deadlock; the second sees where the first left them.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM work_order WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
      if (locked.length !== ids.length) {
        throw new NotFoundException('Work order not found');
      }
      const rows = await tx.workOrder.findMany({ where: { id: { in: ids } }, include: { ...pieceInclude, group: true } });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const pieces = ids.map((id) => byId.get(id)!);
      const label = (piece: (typeof pieces)[number]) => `${piece.number}/${piece.group.quantity}`;

      // The partner each piece's job is with: the one that accepted it, if any. The jobs are held
      // FOR SHARE, so moving a job to another partner (FOR UPDATE) can't land between this read and
      // the transitions, which would credit a partner that no longer has the job.
      const groupIds = [...new Set(pieces.map((piece) => piece.groupId))].sort();
      await tx.$queryRaw`
        SELECT id FROM work_order_group WHERE id IN (${Prisma.join(groupIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR SHARE`;
      const accepted = await tx.jobAssignment.findMany({
        where: { groupId: { in: groupIds }, status: 'accepted' },
        select: { groupId: true, partnerId: true },
      });
      const partnerOf = new Map(accepted.map((row) => [row.groupId, row.partnerId]));
      if (scope && pieces.some((piece) => partnerOf.get(piece.groupId) !== scope.partnerId)) {
        // Another partner's pieces, or a job not accepted yet, look like no pieces at all.
        throw new NotFoundException('Work order not found');
      }

      const replacements = body.kind === 'correction' ? await this.untouchedReplacements(tx, pieces) : new Map<string, ReplacementRow>();
      const cancelling = new Set([...replacements.values()].map((replacement) => replacement.id));

      // Every piece moves the same way, so all must stand where the move expects (Review Focus 2).
      const versionId = pieces[0].group.workflowVersionId;
      const blocker = (piece: (typeof pieces)[number]): string | null => {
        if (piece.group.workflowVersionId !== versionId) {
          return `runs on another version of the workflow than ${label(pieces[0])}`;
        }
        // A correction may reopen a finished piece, or restore a scrapped one while its replacement is untouched (B3).
        const movable = body.kind === 'correction' ? ['active', 'finished', 'scrapped'] : ['active'];
        if (!movable.includes(piece.status)) {
          return `is ${piece.status}`;
        }
        if (piece.status === 'scrapped' && !replacements.has(piece.id)) {
          return 'is scrapped, and its replacement has already moved';
        }
        if (cancelling.has(piece.id)) {
          return 'replaces a piece this correction restores, so it is cancelled instead';
        }
        if (body.kind !== 'correction' && piece.currentStep?.key !== body.at_step) {
          return `is at ${piece.currentStep!.key}, not ${body.at_step!}`;
        }
        return null;
      };
      const mismatched: MoveProblem[] = [];
      pieces.forEach((piece, index) => {
        const reason = blocker(piece);
        if (reason) {
          mismatched.push({ path: `work_order_ids.${index}`, message: `${label(piece)} ${reason}` });
        }
      });
      if (mismatched.length > 0) {
        throw new ConflictException({ message: 'Some pieces cannot make this move', errors: mismatched });
      }

      const steps = await tx.workflowStep.findMany({ where: { versionId }, include: { stepType: true }, orderBy: { position: 'asc' } });
      const stepByKey = new Map(steps.map((step) => [step.key, step]));
      const stepById = new Map(steps.map((step) => [step.id, step]));
      const here = body.kind === 'correction' ? undefined : stepByKey.get(body.at_step!)!;
      const config = here ? (here.config as StepConfig) : undefined;

      if (scope) {
        const inHouse: MoveProblem[] = [];
        pieces.forEach((piece, index) => {
          const touched =
            body.kind === 'correction'
              ? [piece.currentStepId ? stepById.get(piece.currentStepId) : undefined, stepByKey.get(body.to_step!)]
              : [here];
          const workspaceStep = touched.find((step) => step?.doneBy === 'workspace');
          if (workspaceStep) {
            inHouse.push({ path: `work_order_ids.${index}`, message: `${label(piece)}: ${workspaceStep.key} is done by the workspace` });
          }
        });
        if (inHouse.length > 0) {
          throw new ConflictException({ message: "Some pieces would move at the workspace's own steps", errors: inHouse });
        }
      }
      /** The partner a move made at `stepId` counts for. */
      const creditFor = (groupId: string, stepId: string | null): string | null =>
        stepId !== null && stepById.get(stepId)?.doneBy === 'partner' ? (partnerOf.get(groupId) ?? null) : null;

      const problems = checkMove(config ?? NO_CHECKS, body);
      if (problems.length > 0) {
        throw new BadRequestException({ message: 'The move does not pass the QC gate', errors: problems });
      }

      const photoIds = body.photo_file_version_ids ?? [];
      if (photoIds.length > 0) {
        const found = await tx.fileVersion.count({ where: { id: { in: photoIds }, status: { in: ATTACHABLE } } });
        if (found !== photoIds.length) {
          throw new NotFoundException('Photo not found');
        }
      }

      const fail = body.kind === 'fail' ? this.failRoute(config!, body) : undefined;

      // Each group's path, from the steps the version shares.
      const paths = new Map<string, string[]>();
      const pathOf = (piece: (typeof pieces)[number]) => {
        if (!paths.has(piece.groupId)) {
          paths.set(piece.groupId, pathFor(stepsForPath(steps), chainOf(piece.group)));
        }
        return paths.get(piece.groupId)!;
      };
      const landings = pieces.map((piece, index) => this.landing(body, fail, steps, pathOf(piece), piece.currentStepId, index));
      const refusals = landings.filter((landing): landing is MoveProblem => 'path' in landing);
      if (refusals.length > 0) {
        throw new BadRequestException({ message: 'Some pieces cannot go there', errors: refusals });
      }

      // A move counts for the step it is made at; reopening a finished piece, for the step it reopens at.
      const credited = pieces.map((piece, index) =>
        creditFor(piece.groupId, piece.currentStepId ?? (landings[index] as Landing).stepId),
      );
      await this.write(tx, auth.userId, body, fail, config, pieces, landings as Landing[], credited);

      // A scrapped piece is replaced at once, under its number, at the first step of the same path.
      const scrapped = pieces.filter((_, index) => (landings[index] as Landing).status === 'scrapped');
      if (scrapped.length > 0) {
        await tx.workOrder.createMany({
          data: scrapped.map((piece) => ({
            id: newId(),
            groupId: piece.groupId,
            number: piece.number,
            replacesId: piece.id,
            currentStepId: pathOf(piece)[0],
          })),
        });
      }
      // A restored piece's replacement is cancelled, and the log says so.
      const restored = pieces.filter((piece) => piece.status === 'scrapped');
      const cancelled = restored.map((piece) => replacements.get(piece.id)!);
      if (cancelled.length > 0) {
        await tx.transition.createMany({
          data: cancelled.map((replacement, index) => ({
            id: newId(),
            workOrderId: replacement.id,
            kind: 'correction',
            fromStepId: replacement.currentStepId,
            toStepId: null,
            fromStatus: 'active',
            toStatus: 'cancelled',
            comment: body.comment ? body.comment : null,
            actorUserId: auth.userId,
            partnerId: creditFor(restored[index].groupId, replacement.currentStepId),
          })),
        });
        await tx.workOrder.updateMany({
          where: { id: { in: cancelled.map((replacement) => replacement.id) } },
          data: { status: 'cancelled', currentStepId: null },
        });
      }

      const moved = await tx.workOrder.findMany({ where: { id: { in: ids } }, include: pieceInclude });
      const movedById = new Map(moved.map((row) => [row.id, row]));
      return { data: ids.map((id) => toWorkOrder(movedById.get(id)!)) };
    });
  }

  /**
   * The active replacements of the scrapped pieces among `pieces` that have not moved yet, by the piece they
   * replace. They are locked, so a move of the replacement can't slip in before the restore.
   */
  private async untouchedReplacements(
    tx: Prisma.TransactionClient,
    pieces: { id: string; status: string }[],
  ): Promise<Map<string, ReplacementRow>> {
    const scrapped = pieces.filter((piece) => piece.status === 'scrapped').map((piece) => piece.id);
    if (scrapped.length === 0) {
      return new Map();
    }
    await tx.$queryRaw`
      SELECT id FROM work_order
      WHERE replaces_id IN (${Prisma.join(scrapped.map((id) => Prisma.sql`${id}::uuid`))}) AND status = 'active'
      ORDER BY id FOR UPDATE`;
    const rows = await tx.workOrder.findMany({
      where: { replacesId: { in: scrapped }, status: 'active', transitions: { none: {} } },
      select: { id: true, replacesId: true, currentStepId: true },
    });
    return new Map(rows.map((row) => [row.replacesId!, row]));
  }

  /** What a fail does: the defect's default outcome and target, or an override with a reason (D38). */
  private failRoute(config: StepConfig, body: MoveBody): { outcome: Outcome; reworkTo: string | null } {
    const defect = config.defects.find((candidate) => candidate.defect_id === body.defect_id)!;
    const outcome = body.outcome ?? defect.outcome;
    if (outcome !== 'rework' && body.rework_to !== undefined) {
      throw new BadRequestException({ message: 'Only a rework goes back to a step', errors: [{ path: 'rework_to', message: 'only a rework takes this' }] });
    }
    const reworkTo = outcome === 'rework' ? (body.rework_to ?? defect.rework_to ?? null) : null;
    if (outcome === 'rework' && reworkTo === null) {
      throw new BadRequestException({ message: 'A rework names the step to go back to', errors: [{ path: 'rework_to', message: 'required for a rework' }] });
    }
    if (reworkTo !== null && !config.rework_targets.includes(reworkTo)) {
      throw new BadRequestException({
        message: `${reworkTo} is not a step this one sends pieces back to`,
        errors: [{ path: 'rework_to', message: `not one of ${config.rework_targets.join(', ') || 'no steps'}` }],
      });
    }
    const overridden = outcome !== defect.outcome || (outcome === 'rework' && reworkTo !== defect.rework_to);
    if (overridden && body.override_reason === undefined) {
      throw new BadRequestException({
        message: "Not following the defect's default needs a reason",
        errors: [{ path: 'override_reason', message: 'required when the outcome or rework target is overridden' }],
      });
    }
    if (!overridden && body.override_reason !== undefined) {
      throw new BadRequestException({
        message: "The move follows the defect's default, so there is nothing to give a reason for",
        errors: [{ path: 'override_reason', message: 'only with an overridden outcome or rework target' }],
      });
    }
    return { outcome, reworkTo };
  }

  /** Where one piece lands, or why it can't: its next step, its rework target, or the corrected step. */
  private landing(
    body: MoveBody,
    fail: { outcome: Outcome; reworkTo: string | null } | undefined,
    steps: WorkflowStepRow[],
    path: string[],
    currentStepId: string | null,
    index: number,
  ): Landing | MoveProblem {
    const onPath = (key: string, field: string): Landing | MoveProblem => {
      const step = steps.find((candidate) => candidate.key === key);
      return step && path.includes(step.id)
        ? { stepId: step.id, status: 'active' }
        : { path: field, message: `${key} is not on the path of the piece at work_order_ids.${index}` };
    };
    if (body.kind === 'correction') {
      const landing = onPath(body.to_step!, 'to_step');
      return 'stepId' in landing && landing.stepId === currentStepId
        ? { path: `work_order_ids.${index}`, message: `The piece is already at ${body.to_step!}` }
        : landing;
    }
    if (fail?.outcome === 'scrap') {
      return { stepId: null, status: 'scrapped' };
    }
    if (fail?.outcome === 'rework') {
      return onPath(fail.reworkTo!, 'rework_to');
    }
    // A pass, or a fail that continues: the next step on the path, or done after the last.
    const at = path.indexOf(currentStepId!);
    if (at === -1) {
      // Paths are fixed per version, so this means stored data disagrees; refuse rather than guess.
      throw new ConflictException(`The piece at work_order_ids.${index} is at a step that is not on its path`);
    }
    const next = path[at + 1];
    return next ? { stepId: next, status: 'active' } : { stepId: null, status: 'finished' };
  }

  /** One transition per piece, each with the same answers and photos, and the pieces where they landed. */
  private async write(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    body: MoveBody,
    fail: { outcome: Outcome } | undefined,
    config: StepConfig | undefined,
    pieces: { id: string; status: string; currentStepId: string | null }[],
    landings: Landing[],
    partnerIds: (string | null)[],
  ): Promise<void> {
    const comment = body.comment && body.comment.length > 0 ? body.comment : null;
    const transitions = pieces.map((piece, index) => ({
      id: newId(),
      workOrderId: piece.id,
      kind: body.kind,
      outcome: fail?.outcome ?? null,
      fromStepId: piece.currentStepId,
      toStepId: landings[index].stepId,
      fromStatus: piece.status,
      toStatus: landings[index].status,
      defectId: body.defect_id ?? null,
      overrideReason: body.override_reason ?? null,
      comment,
      actorUserId,
      partnerId: partnerIds[index],
    }));
    await tx.transition.createMany({ data: transitions });

    const answers = (body.answers ?? []).map((answer) => {
      const item = config!.checklist.find((candidate) => candidate.key === answer.item)!;
      return { itemKey: answer.item, value: String(answer.value), note: answer.note ?? null, passing: judge(item, answer.value) === true };
    });
    if (answers.length > 0) {
      await tx.transitionAnswer.createMany({
        data: transitions.flatMap((transition) => answers.map((answer) => ({ id: newId(), transitionId: transition.id, ...answer }))),
      });
    }
    const photoIds = body.photo_file_version_ids ?? [];
    if (photoIds.length > 0) {
      await tx.transitionPhoto.createMany({
        data: transitions.flatMap((transition) =>
          photoIds.map((fileVersionId) => ({ id: newId(), transitionId: transition.id, fileVersionId })),
        ),
      });
    }

    // Pieces that land together are updated together.
    const together = new Map<string, string[]>();
    landings.forEach((landing, index) => {
      const key = `${landing.status}:${landing.stepId ?? ''}`;
      together.set(key, [...(together.get(key) ?? []), pieces[index].id]);
    });
    for (const [key, ids] of together) {
      const [status, stepId] = key.split(':');
      await tx.workOrder.updateMany({ where: { id: { in: ids } }, data: { status, currentStepId: stepId || null } });
    }
  }
}
