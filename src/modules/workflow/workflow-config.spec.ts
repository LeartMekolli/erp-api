import { workflowStepsSchema } from './workflow-config';

const STEP_TYPE = '0190a6a0-0000-7000-8000-000000000001';
const POROSITY = '0190a6a0-0000-7000-8000-000000000002';

const step = (key: string, extra: object = {}) => ({ key, name: key, step_type_id: STEP_TYPE, ...extra });

describe('workflow step configuration', () => {
  it('accepts a casting workflow and fills in the defaults', () => {
    const parsed = workflowStepsSchema.parse({
      steps: [
        step('casting'),
        step('polishing', {
          checklist: [
            {
              key: 'surface',
              label: 'Surface',
              required: true,
              kind: 'choice',
              options: [
                { key: 'ok', label: 'Smooth', passing: true },
                { key: 'pitted', label: 'Pitted', passing: false },
              ],
            },
            { key: 'weight', label: 'Weight', required: false, kind: 'number', unit: 'g', min: '4.8', max: '5.2' },
          ],
          defects: [{ defect_id: POROSITY, outcome: 'rework', rework_to: 'casting' }],
          rework_targets: ['casting'],
          fail: { min_photos: 1, comment_required: true },
          customer: { visible: true, name: 'Finishing' },
        }),
      ],
    });

    expect(parsed.steps[0]).toEqual({
      key: 'casting',
      name: 'casting',
      step_type_id: STEP_TYPE,
      checklist: [],
      defects: [],
      rework_targets: [],
      pass: { min_photos: 0, comment_required: false },
      fail: { min_photos: 0, comment_required: false },
      sop_file_version_id: null,
      expected_minutes: null,
      customer: { visible: false },
    });
    expect(parsed.steps[1]).toMatchObject({ customer: { visible: true, name: 'Finishing' }, rework_targets: ['casting'] });
  });

  it('refuses a rework outcome without a target, or with one the step does not allow', () => {
    for (const defects of [
      [{ defect_id: POROSITY, outcome: 'rework' }],
      [{ defect_id: POROSITY, outcome: 'rework', rework_to: 'printing' }],
    ]) {
      const result = workflowStepsSchema.safeParse({
        steps: [step('printing'), step('casting'), step('polishing', { defects, rework_targets: ['casting'] })],
      });
      expect({ defects, success: result.success }).toEqual({ defects, success: false });
    }
  });

  it('allows rework at the step itself or an earlier one, never a later one', () => {
    const allowed = workflowStepsSchema.safeParse({
      steps: [step('casting'), step('polishing', { rework_targets: ['casting', 'polishing'] }), step('packing')],
    });
    expect(allowed.success).toBe(true);

    for (const rework_targets of [['packing'], ['nowhere'], ['casting', 'casting']]) {
      const result = workflowStepsSchema.safeParse({
        steps: [step('casting'), step('polishing', { rework_targets }), step('packing')],
      });
      expect({ rework_targets, success: result.success }).toEqual({ rework_targets, success: false });
    }
  });

  it('refuses repeated keys and malformed checklist items', () => {
    const items = [
      // A choice needs at least two options.
      { key: 'surface', label: 'Surface', required: true, kind: 'choice', options: [{ key: 'ok', label: 'Ok', passing: true }] },
      { key: 'weight', label: 'Weight', required: true, kind: 'number', unit: 'g', min: '5.2', max: '4.8' },
      { key: 'Weight', label: 'Weight', required: true, kind: 'text' },
      { key: 'tone', label: 'Tone', required: true, kind: 'colour' },
    ];
    for (const item of items) {
      const result = workflowStepsSchema.safeParse({ steps: [step('polishing', { checklist: [item] })] });
      expect({ item, success: result.success }).toEqual({ item, success: false });
    }

    const twice = { key: 'surface', label: 'Surface', required: true, kind: 'text' };
    expect(workflowStepsSchema.safeParse({ steps: [step('polishing', { checklist: [twice, twice] })] }).success).toBe(false);
    expect(workflowStepsSchema.safeParse({ steps: [step('casting'), step('casting')] }).success).toBe(false);
    expect(workflowStepsSchema.safeParse({ steps: [] }).success).toBe(false);
  });

  it('refuses a customer-visible step without a customer name', () => {
    const result = workflowStepsSchema.safeParse({ steps: [step('casting', { customer: { visible: true } })] });
    expect(result.success).toBe(false);
  });
});
