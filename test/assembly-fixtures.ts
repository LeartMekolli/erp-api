import type request from 'supertest';
import type { PrismaService } from '../src/database/prisma.service';
import { measuredDesign } from './catalog-fixtures';
import { pricedCastPart } from './pricing-fixtures';
import type { StaffClient } from './pricing-fixtures';

/** A staff client that can also publish products. */
export interface AssemblyStaffClient extends StaffClient {
  patch(path: string, body: object): request.Test;
}

/**
 * The pendant set (Orders spec, "Done when" 6), on top of `pricedCastPart`, published:
 * - Pendant: a ready-made cast part on the cast chain and workflow, sizes S (0.9) and M (1), the 10 mm cube.
 * - Bail: a ready-made printed part in pattern resin (fixed), no sizing, one `print` step (machine time 10 min
 *   at 6/h) on a "Printed parts" workflow print → final QC → packing.
 * - Pendant set: an assembly offering material and finish, made of the pendant ×1 at M and the bail ×2, on an
 *   "Assemblies" workflow assembly → packing. Its own `assembly` step is labour (10 min at 30/h) plus one
 *   bought chain per set (`chain`, 3.00 a piece, by hand). A crack scraps a set at its assembly step.
 */
export async function pricedAssembly(
  staff: AssemblyStaffClient,
  prisma: PrismaService,
  tenant: { id: string; staffUserId: string; runMetal: string },
) {
  const cast = await pricedCastPart(staff, prisma, tenant);
  const id = (response: request.Response) => (response.body as { id: string }).id;
  const { finalQc, packing } = cast.workflow.notPriced;
  const options = {
    groups: [
      { group_id: await groupId(prisma, tenant.id, 'material'), required: true, value_ids: [cast.v.silver, cast.v.brass] },
      { group_id: await groupId(prisma, tenant.id, 'finish'), required: true, default_value_id: cast.v.raw, value_ids: [cast.v.raw, cast.v.polished, cast.v.gold] },
    ],
  };

  // The pendant: the cast part, ready-made.
  const pendant = id(
    await staff
      .post('/catalog/products', {
        category_id: cast.categoryId,
        key: 'pendant_part',
        name: 'Pendant',
        kind: 'ready_made',
        sizing: {
          mode: 'named',
          sizes: [
            { key: 'S', scale: '0.9' },
            { key: 'M', scale: '1' },
          ],
        },
      })
      .expect(201),
  );
  await staff.put(`/catalog/products/${pendant}/options`, options).expect(200);
  await staff.put(`/catalog/products/${pendant}/design-file`, { file_version_id: cast.versionId }).expect(200);

  // The bail: printed in pattern resin, its one step priced by machine time.
  const printed = id(await staff.post('/catalog/categories', { key: 'printed_parts', name: 'Printed parts', required_measures: ['volume'] }).expect(201));
  const print = id(await staff.post('/pricing/step-types', { key: 'print', name: 'Print', position: 10, summary_group: 'making' }).expect(201));
  await staff.put(`/pricing/categories/${printed}/steps`, { step_type_ids: [print] }).expect(200);
  await staff.put(`/pricing/step-types/${print}/prices`, { failure_percent: '0', blocks: [{ kind: 'machine_time', base_minutes: '10', hourly_rate: '6' }] }).expect(200);
  const printedWorkflow = id(await staff.post('/workflow/workflows', { key: 'printed_parts', name: 'Printed parts' }).expect(201));
  await staff
    .put(`/workflow/workflows/${printedWorkflow}/steps`, {
      steps: [
        { key: 'print', name: 'Print', step_type_id: print },
        { key: 'final_qc', name: 'Final QC', step_type_id: finalQc },
        { key: 'packing', name: 'Packing', step_type_id: packing },
      ],
    })
    .expect(200);
  await staff.put(`/workflow/categories/${printed}/workflow`, { workflow_id: printedWorkflow }).expect(200);
  const bail = id(
    await staff
      .post('/catalog/products', { category_id: printed, key: 'bail_part', name: 'Bail', kind: 'ready_made', material_id: cast.resin })
      .expect(201),
  );
  await staff.put(`/catalog/products/${bail}/design-file`, { file_version_id: (await measuredDesign(prisma, tenant.id, tenant.staffUserId)).versionId }).expect(200);

  // The set: its own assembly step, with a bought chain per set.
  const chain = id(
    await staff.post('/catalog/materials', { key: 'chain', name: 'Chain', priced_unit: 'piece', price_source: 'manual', manual_price: '3.00' }).expect(201),
  );
  const assemblies = id(await staff.post('/catalog/categories', { key: 'assemblies', name: 'Assemblies', required_measures: [] }).expect(201));
  const assembly = id(await staff.post('/pricing/step-types', { key: 'assembly', name: 'Assembly', position: 70, summary_group: 'finishing' }).expect(201));
  await staff.put(`/pricing/categories/${assemblies}/steps`, { step_type_ids: [assembly] }).expect(200);
  await staff
    .put(`/pricing/step-types/${assembly}/prices`, {
      failure_percent: '0',
      blocks: [
        { kind: 'labour', base_minutes: '10', hourly_rate: '30' },
        { kind: 'material', source: { material_id: chain }, basis: 'piece', loss_percent: '0' },
      ],
    })
    .expect(200);
  /** Changes what a bought chain costs, and so the set's price. */
  const setChainPrice = (price: string) => staff.patch(`/catalog/materials/${chain}`, { manual_price: price }).expect(200);
  const assemblyWorkflow = id(await staff.post('/workflow/workflows', { key: 'assemblies', name: 'Assemblies' }).expect(201));
  await staff
    .put(`/workflow/workflows/${assemblyWorkflow}/steps`, {
      steps: [
        { key: 'assembly', name: 'Assembly', step_type_id: assembly, defects: [{ defect_id: cast.workflow.defects.crack, outcome: 'scrap' }] },
        { key: 'packing', name: 'Packing', step_type_id: packing },
      ],
    })
    .expect(200);
  await staff.put(`/workflow/categories/${assemblies}/workflow`, { workflow_id: assemblyWorkflow }).expect(200);

  const set = id(
    await staff.post('/catalog/products', { category_id: assemblies, key: 'pendant_set', name: 'Pendant set', kind: 'assembly', published: true }).expect(201),
  );
  await staff.put(`/catalog/products/${set}/options`, options).expect(200);
  await staff
    .put(`/catalog/products/${set}/parts`, {
      parts: [
        { product_id: pendant, quantity: 1, size: { named: 'M' } },
        { product_id: bail, quantity: 2 },
      ],
    })
    .expect(200);

  return { cast, pendant, bail, set, chain, setChainPrice, assemblies, steps: { print, assembly }, options };
}
export type PricedAssembly = Awaited<ReturnType<typeof pricedAssembly>>;

async function groupId(prisma: PrismaService, tenantId: string, key: string): Promise<string> {
  return (await prisma.inTenant(tenantId, (tx) => tx.optionGroup.findFirstOrThrow({ where: { key } }))).id;
}
