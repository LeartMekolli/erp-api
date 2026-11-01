import { mustInspect, pickSample, sampleSize, sampling } from './sampling';
import { workflowStepInputSchema } from './workflow-config';

const STEP = 'step-a';
const LATER = 'step-b';

describe('sampling (Workflow 2, Task 3)', () => {
  const random = sampling.random;
  afterEach(() => {
    sampling.random = random;
  });

  describe('sampleSize', () => {
    it('inspects N of every M, rounded up, at least one and at most the batch', () => {
      expect(sampleSize(10, { inspect: 2, of_every: 10 })).toBe(2);
      expect(sampleSize(50, { inspect: 5, of_every: 50 })).toBe(5);
      expect(sampleSize(3, { inspect: 1, of_every: 50 })).toBe(1);
      expect(sampleSize(4, { inspect: 5, of_every: 5 })).toBe(4);
      expect(sampleSize(11, { inspect: 2, of_every: 10 })).toBe(3);
      expect(sampleSize(1, { inspect: 1, of_every: 1000 })).toBe(1);
    });
  });

  describe('pickSample', () => {
    const pieces = ['p1', 'p2', 'p3', 'p4', 'p5'];

    it('takes each piece at the index the random source gives, from those left, in the order given', () => {
      sampling.random = () => 0;
      expect(pickSample(pieces, 2)).toEqual(['p1', 'p2']);

      const picks = [3, 3];
      sampling.random = () => picks.shift()!;
      // p4 from five, then p5 from the four left (p1, p2, p3, p5).
      expect(pickSample(pieces, 2)).toEqual(['p4', 'p5']);
    });

    it('asks the random source for an index below the number of pieces left', () => {
      const asked: number[] = [];
      sampling.random = (max) => {
        asked.push(max);
        return max - 1;
      };
      expect(pickSample(pieces, 3)).toEqual(['p5', 'p4', 'p3']);
      expect(asked).toEqual([5, 4, 3]);
    });

    it('never picks a piece twice, and never more pieces than there are', () => {
      const drawn = pickSample(pieces, 10);
      expect([...drawn].sort()).toEqual(pieces);
      expect(new Set(pickSample(pieces, 3)).size).toBe(3);
      expect(pickSample([], 2)).toEqual([]);
    });
  });

  describe('mustInspect', () => {
    const plain = { id: 'p1', replacesId: null, history: [] };
    const open = { ended: false, drawn: new Set(['p2']) };

    it('is false only for an undrawn, plain piece while sampling runs', () => {
      expect(mustInspect(plain, open)).toBe(false);
    });

    it('is true where the step does not sample, and once the draw has ended', () => {
      expect(mustInspect(plain, null)).toBe(true);
      expect(mustInspect(plain, { ...open, ended: true })).toBe(true);
    });

    it('is true for a drawn piece and for a replacement', () => {
      expect(mustInspect({ ...plain, id: 'p2' }, open)).toBe(true);
      expect(mustInspect({ ...plain, replacesId: 'p0' }, open)).toBe(true);
    });

    it('is true for a piece back from a rework that is still open, not one that has closed', () => {
      const failedLater = { kind: 'fail', outcome: 'rework', fromStepId: LATER };
      expect(mustInspect({ ...plain, history: [failedLater] }, open)).toBe(true);

      const closed = [
        { kind: 'fail', outcome: 'rework', fromStepId: STEP },
        { kind: 'pass', outcome: null, fromStepId: STEP },
      ];
      expect(mustInspect({ ...plain, history: closed }, open)).toBe(false);
    });
  });

  describe('the step setting', () => {
    const step = { key: 'inspection', name: 'Inspection', step_type_id: '01a19842-6dcf-734f-9072-5b0f9f59f95f' };

    it('is off by default, and takes N of every M with N between 1 and M', () => {
      expect(workflowStepInputSchema.parse(step).sampling).toBeNull();
      expect(workflowStepInputSchema.parse({ ...step, sampling: { inspect: 2, of_every: 10 } }).sampling).toEqual({
        inspect: 2,
        of_every: 10,
      });
      expect(workflowStepInputSchema.parse({ ...step, sampling: { inspect: 5, of_every: 5 } }).sampling).toEqual({
        inspect: 5,
        of_every: 5,
      });
      for (const sampling of [
        { inspect: 0, of_every: 10 },
        { inspect: 11, of_every: 10 },
        { inspect: 1.5, of_every: 10 },
        { inspect: 1 },
        { inspect: 1, of_every: 10, extra: true },
      ]) {
        expect(workflowStepInputSchema.safeParse({ ...step, sampling }).success).toBe(false);
      }
    });
  });
});
