import { z } from 'zod';
import { groupSummarySchema } from './group-summary-response';
import { transitionResponseSchema, WORK_ORDER_STATUSES } from './work-order-response';

// What clients receive for a line's moves, one item per action; checked against real responses in the e2e tests.

const move = transitionResponseSchema.shape;

/** One piece an action moved, in this line. */
export const actionPieceSchema = z.strictObject({
  id: z.uuid(),
  /** The piece's number out of the group's quantity, such as "3/10". */
  label: z.string(),
  /** Replaces a scrapped piece, so it shares that piece's number. */
  replacement: z.boolean(),
  from_step: move.from_step,
  to_step: move.to_step,
  /** The piece's status after the move. */
  status: z.enum(WORK_ORDER_STATUSES),
});

export const actionResponseSchema = z.strictObject({
  /** The `move_id` every row of the action shares. */
  id: z.uuid(),
  kind: move.kind,
  outcome: move.outcome,
  /** The step every piece moved from; null when they differ, or none was at a step. */
  from_step: move.from_step,
  /** The step every piece landed on; null when they differ, or none landed on a step. */
  to_step: move.to_step,
  defect: move.defect,
  override_reason: move.override_reason,
  comment: move.comment,
  answers: move.answers,
  photos: move.photos,
  actor: move.actor,
  /** The partner the action counts for in this line, if any. */
  partner: move.partner,
  inspected: move.inspected,
  created_at: move.created_at,
  /** In label order, a replacement after the piece it shares a number with. */
  pieces: z.array(actionPieceSchema),
});
export type ActionResponse = z.infer<typeof actionResponseSchema>;

/**
 * A move in the QC history across every line (Production lists spec, goal 5): the action as a line's history
 * shows it, with every line it touched, whatever the filters matched.
 */
export const moveListItemSchema = actionResponseSchema.omit({ pieces: true, partner: true }).extend({
  /** Each line the move touched, in the order it moved them: how many of its pieces, and the partner it counts for. */
  groups: z.array(
    z.strictObject({
      group: groupSummarySchema,
      count: z.number().int(),
      partner: move.partner,
    }),
  ),
});
export type MoveListItem = z.infer<typeof moveListItemSchema>;

/** Someone who has made a move, for History's Person filter (Move actors spec, 2026-11-26). */
export const moveActorSchema = z.strictObject({
  /** Pass as `actor_user_id` to `GET /workflow/moves`. */
  id: z.uuid(),
  name: z.string(),
  /** A partner's person stays `partner` after leaving every partner. */
  kind: z.enum(['staff', 'partner']),
  /** The partners the person belongs to now, by name; empty for staff and for a partner's person who left. */
  partners: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
});
export type MoveActor = z.infer<typeof moveActorSchema>;

export const moveActorsResponseSchema = z.strictObject({
  /** By name. Not paged. */
  data: z.array(moveActorSchema),
});
export type MoveActorsResponse = z.infer<typeof moveActorsResponseSchema>;

export const moveHistoryResponseSchema = z.strictObject({
  data: z.array(actionResponseSchema),
  next_cursor: z.string().nullable(),
  /** The line's actions over every page: all of them, and those `only=fails` keeps. */
  counts: z.strictObject({ all: z.number().int(), fails: z.number().int() }),
});
export type MoveHistoryResponse = z.infer<typeof moveHistoryResponseSchema>;
