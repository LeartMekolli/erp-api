/**
 * A partner's score (Partners spec, goal 15; P14): parts derived from its real work and its customer
 * ratings, never stored, and one overall score out of 5 mixed by the workspace's weights.
 */

/** How far back the parts look. */
export const SCORE_DAYS = 90;
/** Below this, a partner shows "new" instead of an overall score. */
export const MIN_FINISHED_JOBS = 5;

export interface ScoreWeights {
  quality: number;
  scrap: number;
  reliability: number;
  onTime: number;
  rating: number;
}

/** Used until the workspace sets `partners.scoreWeights`. */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = { quality: 3, scrap: 2, reliability: 2, onTime: 1, rating: 3 };

/** Each part a share from 0 to 1; null when there is nothing to go on. */
export interface ScoreParts {
  quality: number | null;
  scrap: number | null;
  reliability: number | null;
  /** Due dates come with Orders; until then always null. */
  onTime: null;
  rating: number | null;
}

/** What the parts are worked out from, over the score's period. */
export interface ScoreFacts {
  /** Moves that count for the partner, oldest first. */
  moves: { workOrderId: string; fromStepId: string | null; kind: string; toStatus: string }[];
  /** Offers made to the partner. */
  offers: { status: string }[];
  /** Customers' stars for its jobs, 1 to 5. */
  stars: number[];
}

/** Offers the partner took: a replaced job was accepted first. */
const TAKEN = new Set(['accepted', 'replaced']);
/** Offers the partner answered, or let lapse. */
const ANSWERED = new Set(['accepted', 'replaced', 'declined', 'expired']);

const share = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

export function scoreParts(facts: ScoreFacts): ScoreParts {
  // Quality: each piece's first pass or fail from each step; a correction is staff putting a piece back, not a QC result.
  const first = new Map<string, string>();
  for (const move of facts.moves) {
    if (move.fromStepId === null || move.kind === 'correction') continue;
    const visit = `${move.workOrderId}:${move.fromStepId}`;
    if (!first.has(visit)) first.set(visit, move.kind);
  }
  const firstTime = [...first.values()].filter((kind) => kind === 'pass').length;

  const pieces = new Set(facts.moves.map((move) => move.workOrderId));
  const scrapped = new Set(facts.moves.filter((move) => move.toStatus === 'scrapped').map((move) => move.workOrderId));
  const scrapShare = share(scrapped.size, pieces.size);

  const answered = facts.offers.filter((offer) => ANSWERED.has(offer.status));
  const stars = facts.stars.map((value) => (value - 1) / 4);

  return {
    quality: share(firstTime, first.size),
    scrap: scrapShare === null ? null : 1 - scrapShare,
    reliability: share(answered.filter((offer) => TAKEN.has(offer.status)).length, answered.length),
    onTime: null,
    rating: share(
      stars.reduce((sum, value) => sum + value, 0),
      stars.length,
    ),
  };
}

/**
 * The weighted mean of the parts that have data and weight, out of 5, to one decimal; null ("new") for
 * a partner with fewer than 5 finished jobs, or with no part to go on.
 */
export function overallScore(parts: ScoreParts, weights: ScoreWeights, finishedJobs: number): number | null {
  if (finishedJobs < MIN_FINISHED_JOBS) return null;
  let weighted = 0;
  let total = 0;
  for (const key of Object.keys(weights) as (keyof ScoreWeights)[]) {
    const value = parts[key];
    if (value === null || weights[key] === 0) continue;
    weighted += weights[key] * value;
    total += weights[key];
  }
  return total === 0 ? null : Math.round((weighted / total) * 5 * 10) / 10;
}
