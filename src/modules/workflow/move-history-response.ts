import { z } from 'zod';
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

export const moveHistoryResponseSchema = z.strictObject({
  data: z.array(actionResponseSchema),
  next_cursor: z.string().nullable(),
  /** The line's actions over every page: all of them, and those `only=fails` keeps. */
  counts: z.strictObject({ all: z.number().int(), fails: z.number().int() }),
});
export type MoveHistoryResponse = z.infer<typeof moveHistoryResponseSchema>;
