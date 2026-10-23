import type request from 'supertest';
import type { StaffClient } from './pricing-fixtures';

/** The cast part's priced step types, by name. */
export interface CastStepTypes {
  printPattern: string;
  castingTree: string;
  casting: string;
  polishing: string;
  plating: string;
}

/**
 * The cast part's workflow, "Cast rings", assigned to its category: print pattern → casting tree → casting
 * → polishing → plating → final QC → packing. Final QC and packing are not-priced step types made here.
 * Defects: porosity (rework at casting), scratch (rework at polishing), crack (scrap). Polishing asks for a
 * required "Surface" (`ok` passes, `pitted` fails) and a fail needs a comment; final QC asks for a required
 * "Weight" in g, 4.8–5.2, and a pass needs a photo. Customers see casting as "Casting", polishing as
 * "Finishing" and final QC as "Quality check"; the rest is hidden.
 *
 * `setSteps(extra)` sends the steps again with `extra` before final QC, which adds the next version.
 */
export async function castWorkflow(staff: StaffClient, cast: { steps: CastStepTypes; categoryId: string }) {
  const id = (response: request.Response) => (response.body as { id: string }).id;
  const notPriced = async (key: string, name: string, position: number) =>
    id(await staff.post('/pricing/step-types', { key, name, position, summary_group: null }).expect(201));
  const finalQc = await notPriced('final_qc', 'Final QC', 90);
  const packing = await notPriced('packing', 'Packing', 95);

  const defect = async (key: string, name: string) => id(await staff.post('/workflow/defects', { key, name }).expect(201));
  const defects = {
    porosity: await defect('porosity', 'Porosity'),
    scratch: await defect('scratch', 'Scratch'),
    crack: await defect('crack', 'Crack'),
  };

  const workflowId = id(await staff.post('/workflow/workflows', { key: 'cast_rings', name: 'Cast rings' }).expect(201));
  const { steps } = cast;
  const before = [
    { key: 'print_pattern', name: 'Print pattern', step_type_id: steps.printPattern },
    { key: 'casting_tree', name: 'Casting tree', step_type_id: steps.castingTree },
    {
      key: 'casting',
      name: 'Casting',
      step_type_id: steps.casting,
      defects: [
        { defect_id: defects.porosity, outcome: 'rework', rework_to: 'casting' },
        { defect_id: defects.crack, outcome: 'scrap' },
      ],
      rework_targets: ['casting'],
      customer: { visible: true, name: 'Casting' },
    },
    {
      key: 'polishing',
      name: 'Polishing',
      step_type_id: steps.polishing,
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
      ],
      defects: [
        { defect_id: defects.scratch, outcome: 'rework', rework_to: 'polishing' },
        { defect_id: defects.porosity, outcome: 'rework', rework_to: 'casting' },
        { defect_id: defects.crack, outcome: 'scrap' },
      ],
      rework_targets: ['casting', 'polishing'],
      fail: { min_photos: 0, comment_required: true },
      customer: { visible: true, name: 'Finishing' },
    },
    { key: 'plating', name: 'Plating', step_type_id: steps.plating },
  ];
  const after = [
    {
      key: 'final_qc',
      name: 'Final QC',
      step_type_id: finalQc,
      checklist: [{ key: 'weight', label: 'Weight', required: true, kind: 'number', unit: 'g', min: '4.8', max: '5.2' }],
      defects: [{ defect_id: defects.scratch, outcome: 'rework', rework_to: 'polishing' }],
      rework_targets: ['polishing'],
      pass: { min_photos: 1, comment_required: false },
      customer: { visible: true, name: 'Quality check' },
    },
    { key: 'packing', name: 'Packing', step_type_id: packing },
  ];

  const setSteps = (extra: object[] = []) =>
    staff.put(`/workflow/workflows/${workflowId}/steps`, { steps: [...before, ...extra, ...after] }).expect(200);
  await setSteps();
  await staff.put(`/workflow/categories/${cast.categoryId}/workflow`, { workflow_id: workflowId }).expect(200);

  return {
    workflowId,
    stepKeys: ['print_pattern', 'casting_tree', 'casting', 'polishing', 'plating', 'final_qc', 'packing'],
    defects,
    notPriced: { finalQc, packing },
    setSteps,
  };
}
export type CastWorkflow = Awaited<ReturnType<typeof castWorkflow>>;
