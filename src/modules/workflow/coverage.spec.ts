import { missingStepTypes } from './coverage';

describe('which priced steps a workflow is missing', () => {
  const workflow = [{ stepTypeId: 'casting' }, { stepTypeId: 'polishing' }, { stepTypeId: 'final_qc' }];

  it('names each chain step the workflow has no step for, in chain order', () => {
    expect(missingStepTypes(workflow, ['casting', 'engraving', 'polishing', 'plating'])).toEqual(['engraving', 'plating']);
  });

  it('finds nothing missing when every chain step is in the workflow', () => {
    expect(missingStepTypes(workflow, ['casting', 'polishing'])).toEqual([]);
    expect(missingStepTypes(workflow, [])).toEqual([]);
  });

  it('counts a step type the workflow has twice once', () => {
    expect(missingStepTypes([...workflow, { stepTypeId: 'casting' }], ['casting'])).toEqual([]);
  });
});
