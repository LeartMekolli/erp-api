import { partnerStepTypeIds, payoutStepId } from './partner-steps';

const step = (id: string, position: number, doneBy: 'partner' | 'workspace', stepTypeId = `type-${id}`) => ({
  id,
  position,
  doneBy,
  stepTypeId,
});

describe('partner steps', () => {
  const steps = [
    step('packing', 6, 'workspace'),
    step('casting', 2, 'partner'),
    step('final_qc', 5, 'partner'),
    step('polishing', 3, 'partner'),
  ];

  it('takes the payout step the workflow names', () => {
    expect(payoutStepId(steps, 'polishing')).toBe('polishing');
  });

  it('defaults to the last partner step by position, whatever the order given', () => {
    expect(payoutStepId(steps, null)).toBe('final_qc');
  });

  it('has no payout step when the workspace does every step', () => {
    expect(payoutStepId([step('casting', 0, 'workspace'), step('packing', 1, 'workspace')], null)).toBeNull();
  });

  it("lists the step types of the partner's steps only", () => {
    const shared = [
      step('casting', 0, 'partner', 'casting'),
      step('recast', 1, 'partner', 'casting'),
      step('packing', 2, 'workspace', 'packing'),
    ];
    expect(partnerStepTypeIds(shared)).toEqual(new Set(['casting']));
  });
});
