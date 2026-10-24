import { checkMove } from './qc-gate';
import { workflowStepInputSchema } from './workflow-config';

const STEP_TYPE = '0190a6a0-0000-7000-8000-000000000001';
const SCRATCH = '0190a6a0-0000-7000-8000-000000000002';
const CRACK = '0190a6a0-0000-7000-8000-000000000003';
const PHOTO = '0190a6a0-0000-7000-8000-000000000004';

const step = (extra: object) => workflowStepInputSchema.parse({ key: 'step', name: 'Step', step_type_id: STEP_TYPE, ...extra });

const polishing = step({
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
    { key: 'note', label: 'Note', required: false, kind: 'text' },
  ],
  defects: [{ defect_id: SCRATCH, outcome: 'rework', rework_to: 'step' }],
  rework_targets: ['step'],
  fail: { min_photos: 0, comment_required: true },
});

const finalQc = step({
  checklist: [
    { key: 'weight', label: 'Weight', required: true, kind: 'number', unit: 'g', min: '4.8', max: '5.2' },
    { key: 'stamped', label: 'Stamped', required: false, kind: 'yes_no', passing_answer: true },
  ],
  defects: [{ defect_id: SCRATCH, outcome: 'rework', rework_to: 'step' }],
  rework_targets: ['step'],
  pass: { min_photos: 1, comment_required: false },
  fail: { min_photos: 1, comment_required: true },
});

const paths = (problems: { path: string }[]) => problems.map((problem) => problem.path);

describe('the QC gate', () => {
  it('lets a pass through when every required answer is given and passing', () => {
    expect(checkMove(polishing, { kind: 'pass', answers: [{ item: 'surface', value: 'ok' }] })).toEqual([]);
    expect(
      checkMove(finalQc, {
        kind: 'pass',
        answers: [
          { item: 'weight', value: '4.8' },
          { item: 'stamped', value: true },
        ],
        photo_file_version_ids: [PHOTO],
      }),
    ).toEqual([]);
    expect(checkMove(step({}), { kind: 'pass' })).toEqual([]);
  });

  it('refuses a pass with a required answer missing', () => {
    expect(paths(checkMove(polishing, { kind: 'pass', answers: [] }))).toEqual(['surface']);
  });

  it('refuses a pass with an answer that fails its check', () => {
    expect(paths(checkMove(polishing, { kind: 'pass', answers: [{ item: 'surface', value: 'pitted' }] }))).toEqual(['surface']);
    expect(
      paths(checkMove(finalQc, { kind: 'pass', answers: [{ item: 'weight', value: '5.3' }], photo_file_version_ids: [PHOTO] })),
    ).toEqual(['weight']);
    expect(
      paths(
        checkMove(finalQc, {
          kind: 'pass',
          answers: [
            { item: 'weight', value: '5' },
            { item: 'stamped', value: false },
          ],
          photo_file_version_ids: [PHOTO],
        }),
      ),
    ).toEqual(['stamped']);
  });

  it('refuses a pass without the photos the step asks for', () => {
    expect(paths(checkMove(finalQc, { kind: 'pass', answers: [{ item: 'weight', value: '5.0' }] }))).toEqual(['photos']);
  });

  it('refuses answers of the wrong kind, for unknown items, or given twice', () => {
    expect(paths(checkMove(polishing, { kind: 'pass', answers: [{ item: 'surface', value: 'shiny' }] }))).toEqual(['surface']);
    expect(paths(checkMove(polishing, { kind: 'pass', answers: [{ item: 'surface', value: true }] }))).toEqual(['surface']);
    expect(
      paths(checkMove(finalQc, { kind: 'pass', answers: [{ item: 'weight', value: 'heavy' }], photo_file_version_ids: [PHOTO] })),
    ).toEqual(['weight']);
    expect(
      paths(
        checkMove(finalQc, {
          kind: 'pass',
          answers: [
            { item: 'weight', value: '5' },
            { item: 'stamped', value: 'yes' },
          ],
          photo_file_version_ids: [PHOTO],
        }),
      ),
    ).toEqual(['stamped']);
    expect(
      paths(
        checkMove(polishing, {
          kind: 'pass',
          answers: [
            { item: 'surface', value: 'ok' },
            { item: 'colour', value: 'red' },
          ],
        }),
      ),
    ).toEqual(['colour']);
    expect(
      paths(
        checkMove(polishing, {
          kind: 'pass',
          answers: [
            { item: 'surface', value: 'ok' },
            { item: 'surface', value: 'ok' },
          ],
        }),
      ),
    ).toEqual(['surface']);
    expect(paths(checkMove(polishing, { kind: 'pass', answers: [{ item: 'surface', value: 'ok' }, { item: 'note', value: 'x'.repeat(2001) }] }))).toEqual([
      'note',
    ]);
  });

  it('lets a fail record failing answers, but not answers of the wrong kind', () => {
    expect(
      checkMove(polishing, { kind: 'fail', defect_id: SCRATCH, comment: 'Deep scratch', answers: [{ item: 'surface', value: 'pitted' }] }),
    ).toEqual([]);
    expect(checkMove(polishing, { kind: 'fail', defect_id: SCRATCH, comment: 'Deep scratch' })).toEqual([]);
    expect(
      paths(checkMove(polishing, { kind: 'fail', defect_id: SCRATCH, comment: 'Deep scratch', answers: [{ item: 'surface', value: 'shiny' }] })),
    ).toEqual(['surface']);
  });

  it('refuses a fail without a defect, or with one the step does not allow', () => {
    expect(paths(checkMove(polishing, { kind: 'fail', comment: 'Deep scratch' }))).toEqual(['defect_id']);
    expect(paths(checkMove(polishing, { kind: 'fail', defect_id: CRACK, comment: 'Cracked' }))).toEqual(['defect_id']);
  });

  it('refuses a fail without the comment and photos the step asks for', () => {
    expect(paths(checkMove(finalQc, { kind: 'fail', defect_id: SCRATCH, photo_file_version_ids: [PHOTO] }))).toEqual(['comment']);
    expect(paths(checkMove(finalQc, { kind: 'fail', defect_id: SCRATCH, comment: '   ', photo_file_version_ids: [PHOTO] }))).toEqual([
      'comment',
    ]);
    expect(paths(checkMove(finalQc, { kind: 'fail', defect_id: SCRATCH, comment: 'Scratched' }))).toEqual(['photos']);
  });

  it('needs only a comment for a correction', () => {
    expect(checkMove(finalQc, { kind: 'correction', comment: 'Passed the wrong tray' })).toEqual([]);
    expect(paths(checkMove(finalQc, { kind: 'correction' }))).toEqual(['comment']);
    expect(paths(checkMove(finalQc, { kind: 'correction', comment: 'Wrong tray', answers: [{ item: 'weight', value: '5' }] }))).toEqual([
      'answers',
    ]);
  });
});
