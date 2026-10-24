import { groupProgress, inRework } from './progress';

const pass = (fromStepId: string) => ({ kind: 'pass', outcome: null, fromStepId });
const fail = (fromStepId: string, outcome: 'rework' | 'scrap' | 'continue') => ({ kind: 'fail', outcome, fromStepId });
const correction = (fromStepId: string | null) => ({ kind: 'correction', outcome: null, fromStepId });

describe('in rework', () => {
  const failedAtPolishing = [pass('print'), pass('casting'), fail('polishing', 'rework')];

  it('is open after a rework fail, until the piece passes the step it failed at', () => {
    expect(inRework([pass('print'), pass('casting')])).toBeNull();
    expect(inRework(failedAtPolishing)).toEqual({ failedAtStepId: 'polishing' });
    expect(inRework([...failedAtPolishing, pass('casting')])).toEqual({ failedAtStepId: 'polishing' });
    expect(inRework([...failedAtPolishing, pass('casting'), pass('polishing')])).toBeNull();
  });

  it('closes when the piece fails again at that step but continues', () => {
    expect(inRework([...failedAtPolishing, pass('casting'), fail('polishing', 'continue')])).toBeNull();
  });

  it('is left as it is by a correction', () => {
    expect(inRework([...failedAtPolishing, correction('casting')])).toEqual({ failedAtStepId: 'polishing' });
    expect(inRework([...failedAtPolishing, pass('casting'), pass('polishing'), correction('final_qc')])).toBeNull();
  });

  it('opens a new rework on a second fail', () => {
    expect(inRework([...failedAtPolishing, pass('casting'), pass('polishing'), fail('final_qc', 'rework')])).toEqual({
      failedAtStepId: 'final_qc',
    });
    expect(inRework([...failedAtPolishing, pass('casting'), fail('casting', 'rework')])).toEqual({ failedAtStepId: 'casting' });
  });

  it('is not opened by a scrap', () => {
    expect(inRework([pass('print'), fail('casting', 'scrap')])).toBeNull();
  });
});

describe('group progress', () => {
  it('counts live pieces per step, those in rework, and pieces by status', () => {
    const path = [
      { id: 'casting', key: 'casting', name: 'Casting' },
      { id: 'polishing', key: 'polishing', name: 'Polishing' },
      { id: 'packing', key: 'packing', name: 'Packing' },
    ];
    const reworked = [pass('casting'), fail('polishing', 'rework')];
    const progress = groupProgress(path, [
      { status: 'active', currentStepId: 'casting', history: reworked },
      { status: 'active', currentStepId: 'casting', history: [] },
      { status: 'active', currentStepId: 'polishing', history: [...reworked, pass('casting')] },
      { status: 'active', currentStepId: 'polishing', history: [pass('casting')] },
      { status: 'finished', currentStepId: null, history: [] },
      { status: 'scrapped', currentStepId: null, history: [fail('casting', 'scrap')] },
      { status: 'cancelled', currentStepId: null, history: [] },
    ]);

    expect(progress).toEqual({
      pieces: { active: 4, finished: 1, scrapped: 1 },
      steps: [
        { key: 'casting', name: 'Casting', count: 2, in_rework: 1 },
        { key: 'polishing', name: 'Polishing', count: 2, in_rework: 1 },
        { key: 'packing', name: 'Packing', count: 0, in_rework: 0 },
      ],
    });
  });
});
