import { DEFAULT_SCORE_WEIGHTS, overallScore, scoreParts } from './score';
import type { ScoreFacts, ScoreParts } from './score';

type Move = ScoreFacts['moves'][number];
const pass = (workOrderId: string, fromStepId: string): Move => ({ workOrderId, fromStepId, kind: 'pass', toStatus: 'active' });
const fail = (workOrderId: string, fromStepId: string, toStatus = 'active'): Move => ({ workOrderId, fromStepId, kind: 'fail', toStatus });
const none: ScoreFacts = { moves: [], offers: [], stars: [] };

describe('the parts of a partner score', () => {
  it('rates quality as the share of pieces that passed a step first time', () => {
    // Ten rings at polishing; ring 0 is scratched and reworked before it passes.
    const moves = [fail('r0', 'polishing'), ...Array.from({ length: 10 }, (_, index) => pass(`r${index}`, 'polishing'))];
    expect(scoreParts({ ...none, moves }).quality).toBeCloseTo(0.9);
  });

  it('counts each piece once per step, and leaves corrections out', () => {
    const moves: Move[] = [
      pass('r0', 'casting'),
      pass('r0', 'polishing'),
      { workOrderId: 'r0', fromStepId: 'packing', kind: 'correction', toStatus: 'active' },
      // Passed polishing again after the correction: still one first-time pass at polishing.
      pass('r0', 'polishing'),
      fail('r1', 'casting'),
      pass('r1', 'casting'),
    ];
    // r0 casting and polishing first time; r1 casting not.
    expect(scoreParts({ ...none, moves }).quality).toBeCloseTo(2 / 3);
  });

  it('keeps scrap as one less the share of pieces scrapped', () => {
    const moves = [...Array.from({ length: 20 }, (_, index) => pass(`r${index}`, 'print_pattern')), fail('r7', 'casting', 'scrapped')];
    expect(scoreParts({ ...none, moves }).scrap).toBeCloseTo(0.95);
  });

  it('rates reliability as the share of answered offers accepted, a replaced one counting as accepted', () => {
    const offers = ['accepted', 'replaced', 'accepted', 'declined', 'withdrawn', 'offered'].map((status) => ({ status }));
    expect(scoreParts({ ...none, offers }).reliability).toBeCloseTo(0.75);
    expect(scoreParts({ ...none, offers: [{ status: 'accepted' }, { status: 'expired' }] }).reliability).toBeCloseTo(0.5);
  });

  it('rates customers stars from 1 to 5 as 0 to 1', () => {
    expect(scoreParts({ ...none, stars: [5, 3] }).rating).toBeCloseTo(0.75);
    expect(scoreParts({ ...none, stars: [1] }).rating).toBe(0);
  });

  it('leaves out a part with nothing to go on, and on time until due dates exist', () => {
    expect(scoreParts(none)).toEqual({ quality: null, scrap: null, reliability: null, onTime: null, rating: null });
    expect(scoreParts({ ...none, offers: [{ status: 'withdrawn' }, { status: 'offered' }] }).reliability).toBeNull();
  });
});

describe('the overall score', () => {
  const parts: ScoreParts = { quality: 0.9, scrap: 0.95, reliability: 0.75, onTime: null, rating: 0.75 };

  it('is the weighted mean of the parts it has, out of 5, to one decimal', () => {
    // (3 × 0.9 + 2 × 0.95 + 2 × 0.75 + 3 × 0.75) / 10 × 5 = 4.175; on time has no data, so its weight is left out.
    expect(overallScore(parts, DEFAULT_SCORE_WEIGHTS, 5)).toBe(4.2);
    // Without ratings: (3 × 0.9 + 2 × 0.95 + 2 × 0.75) / 7 × 5 = 4.357.
    expect(overallScore({ ...parts, rating: null }, DEFAULT_SCORE_WEIGHTS, 5)).toBe(4.4);
  });

  it('follows the workspace weights, leaving out a part weighted 0', () => {
    const ratingOnly = { quality: 0, scrap: 0, reliability: 0, onTime: 0, rating: 1 };
    expect(overallScore(parts, ratingOnly, 5)).toBe(3.8);
    expect(overallScore({ ...parts, rating: null }, ratingOnly, 5)).toBeNull();
  });

  it('is "new", null, with fewer than 5 finished jobs, or with no part to go on', () => {
    expect(overallScore(parts, DEFAULT_SCORE_WEIGHTS, 4)).toBeNull();
    expect(overallScore({ quality: null, scrap: null, reliability: null, onTime: null, rating: null }, DEFAULT_SCORE_WEIGHTS, 9)).toBeNull();
  });
});
