import { stageOf } from './partner-stage';

describe("where a piece stands for the partner", () => {
  // Print and cast are the partner's, the check between them the workspace's, packing the workspace's too.
  const path = [
    { id: 'print', doneBy: 'partner' },
    { id: 'check', doneBy: 'workspace' },
    { id: 'cast', doneBy: 'partner' },
    { id: 'packing', doneBy: 'workspace' },
  ];
  const at = (currentStepId: string) => stageOf(path, { status: 'active', currentStepId });

  it("is the partner's at its own steps", () => {
    expect(at('print')).toBe('yours');
    expect(at('cast')).toBe('yours');
  });

  it('is not yet the partner\'s at a workspace step with a partner step later on the path', () => {
    expect(at('check')).toBe('not_yet');
  });

  it("is done at a workspace step with no partner step left", () => {
    expect(at('packing')).toBe('done');
  });

  it('reads only the path it is given: a partner step left off the path never counts as ahead', () => {
    // A priced step the group's chain leaves out is not on its path.
    const shortened = path.filter((step) => step.id !== 'cast');
    expect(stageOf(shortened, { status: 'active', currentStepId: 'check' })).toBe('done');
  });

  it('is nothing once the piece is finished, scrapped or cancelled', () => {
    for (const status of ['finished', 'scrapped', 'cancelled']) {
      expect(stageOf(path, { status, currentStepId: null })).toBeNull();
    }
  });
});
