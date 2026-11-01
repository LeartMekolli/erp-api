import { randomInt } from 'node:crypto';
import { newId } from '../../common/ids/uuid';
import { Prisma } from '../../generated/prisma/client';
import { inRework } from './progress';
import type { TransitionFacts } from './progress';
import type { StepConfig } from './workflow-config';

// Sampling at a step (Workflow 2 spec, goals 1–8): per group, the system draws which pieces are inspected
// the first time a piece of the group reaches the step; the others pass without the checklist once every
// drawn piece has passed. Any fail at the step ends sampling for the group there.

export interface SamplingRule {
  inspect: number;
  of_every: number;
}

/** `inspect` of every `of_every` pieces, rounded up: at least one, at most the batch. */
export function sampleSize(quantity: number, rule: SamplingRule): number {
  return Math.min(quantity, Math.max(1, Math.ceil((quantity * rule.inspect) / rule.of_every)));
}

/** The draw's source of randomness: an index below `max`. A test may replace `random`. */
export const sampling = { random: (max: number): number => randomInt(max) };

/** `size` of the candidates, each taken at the index `sampling.random` gives among those left, in the order given. */
export function pickSample<T>(candidates: T[], size: number): T[] {
  const left = [...candidates];
  const picked: T[] = [];
  while (picked.length < size && left.length > 0) {
    picked.push(left.splice(sampling.random(left.length), 1)[0]!);
  }
  return picked;
}

/**
 * Whether a piece at a step must be inspected in full: always where the step doesn't sample (`draw` null)
 * or once its draw has ended; else when it is drawn, a replacement, or back from a rework still open
 * (goals 5–7).
 */
export function mustInspect(
  piece: { id: string; replacesId: string | null; history: TransitionFacts[] },
  draw: { ended: boolean; drawn: ReadonlySet<string> } | null,
): boolean {
  return draw === null || draw.ended || draw.drawn.has(piece.id) || piece.replacesId !== null || inRework(piece.history) !== null;
}

const ruleOf = (config: Prisma.JsonValue): SamplingRule | null => (config as StepConfig).sampling ?? null;

/**
 * Draws the group's sample at the step when the step samples and none is drawn yet, from the group's live
 * pieces in number order. Two moves landing at once draw once: the second finds the first's row.
 */
export async function ensureDraw(
  tx: Prisma.TransactionClient,
  group: { id: string; quantity: number },
  step: { id: string; config: Prisma.JsonValue },
): Promise<void> {
  const rule = ruleOf(step.config);
  if (!rule) {
    return;
  }
  const created = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO sample_draw (id, group_id, step_id) VALUES (${newId()}::uuid, ${group.id}::uuid, ${step.id}::uuid)
    ON CONFLICT (tenant_id, group_id, step_id) DO NOTHING RETURNING id`;
  if (created.length === 0) {
    return;
  }
  const live = await tx.workOrder.findMany({
    where: { groupId: group.id, status: { in: ['active', 'finished'] } },
    orderBy: { number: 'asc' },
    select: { id: true },
  });
  const picked = pickSample(live, sampleSize(group.quantity, rule));
  await tx.samplePiece.createMany({ data: picked.map((piece) => ({ drawId: created[0]!.id, workOrderId: piece.id })) });
}

/** The draw's pieces, each followed through its replacements to the live piece standing in its place. */
export async function drawnPieces(tx: Prisma.TransactionClient, drawId: string): Promise<Set<string>> {
  const stored = await tx.samplePiece.findMany({ where: { drawId }, select: { workOrderId: true } });
  const drawn = new Set<string>();
  let frontier = stored.map((row) => row.workOrderId);
  while (frontier.length > 0) {
    const rows = await tx.workOrder.findMany({ where: { id: { in: frontier } }, select: { id: true, status: true } });
    rows.filter((row) => row.status === 'active' || row.status === 'finished').forEach((row) => drawn.add(row.id));
    const gone = rows.filter((row) => row.status === 'scrapped').map((row) => row.id);
    frontier = gone.length === 0 ? [] : (await tx.workOrder.findMany({ where: { replacesId: { in: gone } }, select: { id: true } })).map((row) => row.id);
  }
  return drawn;
}

/** A group's draw at a step, with its live drawn pieces; null where the step doesn't sample. */
export interface DrawState {
  id: string;
  ended: boolean;
  drawn: ReadonlySet<string>;
}

/**
 * Locks these groups' draws at a step until the transaction ends. An uninspected pass takes it before reading
 * the draws, so it waits for a fail at the step that is ending one (its update holds the same row lock) and
 * then reads the draw as ended. In group order, as a fail ends draws, so the two never wait on each other.
 */
export async function lockDraws(tx: Prisma.TransactionClient, stepId: string, groupIds: string[]): Promise<void> {
  if (groupIds.length === 0) {
    return;
  }
  await tx.$queryRaw`
    SELECT id FROM sample_draw
    WHERE step_id = ${stepId}::uuid AND group_id IN (${Prisma.join(groupIds.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY group_id FOR UPDATE`;
}

/** The draws of these groups at a sampling step, by group. A group without one yet has none in the map. */
export async function drawsAt(tx: Prisma.TransactionClient, stepId: string, groupIds: string[]): Promise<Map<string, DrawState>> {
  const draws = await tx.sampleDraw.findMany({ where: { stepId, groupId: { in: groupIds } } });
  const states = new Map<string, DrawState>();
  for (const draw of draws) {
    states.set(draw.groupId, { id: draw.id, ended: draw.endedAt !== null, drawn: await drawnPieces(tx, draw.id) });
  }
  return states;
}

/**
 * `to_inspect` for each piece (goal 3): null unless it is active at a step that samples; else whether it
 * must be inspected in full.
 */
export async function toInspect(
  tx: Prisma.TransactionClient,
  pieces: { id: string; groupId: string; status: string; currentStepId: string | null; replacesId: string | null }[],
): Promise<Map<string, boolean | null>> {
  const result = new Map<string, boolean | null>(pieces.map((piece) => [piece.id, null]));
  const stepIds = [...new Set(pieces.flatMap((piece) => (piece.status === 'active' && piece.currentStepId ? [piece.currentStepId] : [])))];
  const sampled = (await tx.workflowStep.findMany({ where: { id: { in: stepIds } }, select: { id: true, config: true } })).filter(
    (step) => ruleOf(step.config) !== null,
  );
  for (const step of sampled) {
    const here = pieces.filter((piece) => piece.status === 'active' && piece.currentStepId === step.id);
    const draws = await drawsAt(tx, step.id, [...new Set(here.map((piece) => piece.groupId))]);
    const histories = await historiesOf(tx, here.map((piece) => piece.id));
    for (const piece of here) {
      // A sampling step without a draw for the group is one set up after the group reached it: inspect in full.
      const draw = draws.get(piece.groupId) ?? { ended: true, drawn: new Set<string>() };
      result.set(piece.id, mustInspect({ ...piece, history: histories.get(piece.id) ?? [] }, draw));
    }
  }
  return result;
}

/** The pieces' moves, oldest first, as progress reads them. */
export async function historiesOf(tx: Prisma.TransactionClient, ids: string[]): Promise<Map<string, TransitionFacts[]>> {
  const rows = await tx.transition.findMany({
    where: { workOrderId: { in: ids } },
    select: { workOrderId: true, kind: true, outcome: true, fromStepId: true },
    orderBy: { id: 'asc' },
  });
  const histories = new Map<string, TransitionFacts[]>();
  for (const row of rows) {
    histories.set(row.workOrderId, [...(histories.get(row.workOrderId) ?? []), row]);
  }
  return histories;
}
