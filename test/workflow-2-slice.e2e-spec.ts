import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { JobsService } from '../src/jobs/jobs.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { ProgressEmailsService } from '../src/modules/orders/progress-emails.service';
import { ReportsService } from '../src/modules/reporting/reports.service';
import { sampling } from '../src/modules/workflow/sampling';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Piece {
  id: string;
  number: number;
  step: { key: string } | null;
  to_inspect: boolean | null;
}
interface Order {
  id: string;
  number: number;
  lines: { group_id: string }[];
}

/**
 * Workflow 2 end to end: the spec's five "Done when" points in one workspace.
 *
 * Rings run print pattern → casting tree → casting → polishing → inspection → packing. Casting is done
 * in-house, needs the skill "Casting" and emails customers; inspection is in-house and inspects 2 of every
 * 10 pieces. Pendants run the same, except that their "Wax casting" is a partner's, shows customers
 * "Casting" and emails too. Luna Jewels is on the default plan, which has progress emails.
 */
describe('Workflow 2 walkthrough', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let progress: ProgressEmailsService;
  let reports: ReportsService;
  let enqueue: jest.SpyInstance;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;
  const random = sampling.random;

  const http = () => request(app.getHttpServer());
  const id = (response: request.Response) => (response.body as { id: string }).id;
  const detail = (response: request.Response) => (response.body as { detail: string }).detail;
  const client = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    progress = moduleRef.get(ProgressEmailsService);
    reports = moduleRef.get(ReportsService);
    // Moves queue the progress emails; here the walkthrough sends them itself, as the job would.
    enqueue = jest.spyOn(moduleRef.get(JobsService), 'enqueue').mockResolvedValue(undefined);
  });

  afterAll(async () => {
    sampling.random = random;
    enqueue.mockRestore();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('samples, needs skills and tells customers, as the spec is done when', async () => {
    // The random source always takes the first piece left, so pieces 1 and 2 of a batch are drawn.
    sampling.random = () => 0;
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const ownerUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const memberUser = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const owner = client((await tokens.issueForUser(tenant.id, ownerUser.id)).accessToken);
    const member = client((await tokens.issueForUser(tenant.id, memberUser.id)).accessToken);

    // --- Setup: skills, the two workflows, the customer.
    const cast = await pricedCastPart(owner, prisma, { id: tenant.id, staffUserId: ownerUser.id, runMetal });
    const { defects } = cast.workflow;
    const castingSkill = id(await owner.post('/skills', { name: 'Casting' }).expect(201));
    const inspectionType = id(
      await owner.post('/pricing/step-types', { key: 'inspection', name: 'Inspection', position: 46, summary_group: null }).expect(201),
    );
    const workflowSteps = (casting: object) => [
      { key: 'print_pattern', name: 'Print pattern', step_type_id: cast.steps.printPattern },
      { key: 'casting_tree', name: 'Casting tree', step_type_id: cast.steps.castingTree },
      casting,
      {
        key: 'polishing',
        name: 'Polishing',
        step_type_id: cast.steps.polishing,
        defects: [{ defect_id: defects.porosity, outcome: 'rework', rework_to: (casting as { key: string }).key }],
        rework_targets: [(casting as { key: string }).key],
        customer: { visible: true, name: 'Finishing' },
      },
      {
        key: 'inspection',
        name: 'Inspection',
        step_type_id: inspectionType,
        done_by: 'workspace',
        checklist: [{ key: 'looks_ok', label: 'Looks right', required: true, kind: 'yes_no', passing_answer: true }],
        defects: [{ defect_id: defects.scratch, outcome: 'rework', rework_to: 'polishing' }],
        rework_targets: ['polishing'],
        sampling: { inspect: 2, of_every: 10 },
      },
      { key: 'plating', name: 'Plating', step_type_id: cast.steps.plating },
      { key: 'packing', name: 'Packing', step_type_id: cast.workflow.notPriced.packing },
    ];
    const castingStep = (key: string, name: string, extra: object) => ({
      key,
      name,
      step_type_id: cast.steps.casting,
      defects: [{ defect_id: defects.porosity, outcome: 'rework', rework_to: key }],
      rework_targets: [key],
      customer: { visible: true, name: 'Casting', email: true },
      ...extra,
    });
    await owner
      .put(`/workflow/workflows/${cast.workflow.workflowId}/steps`, {
        steps: workflowSteps(castingStep('casting', 'Casting', { done_by: 'workspace', required_skill_id: castingSkill })),
      })
      .expect(200);

    const ringsProduct = (await owner.get(`/catalog/products/${cast.productId}`).expect(200)).body as { options: object[] };
    const pendant = id(
      await owner
        .post('/catalog/products', {
          category_id: cast.categoryId,
          key: 'custom_pendant',
          name: 'Custom pendant',
          kind: 'custom',
          sizing: { mode: 'range', min: '0.5', max: '2' },
        })
        .expect(201),
    );
    await owner.put(`/catalog/products/${pendant}/options`, { groups: ringsProduct.options }).expect(200);
    for (const product of [cast.productId, pendant]) {
      await owner.patch(`/catalog/products/${product}`, { published: true }).expect(200);
    }
    const pendants = id(await owner.post('/workflow/workflows', { key: 'cast_pendants', name: 'Cast pendants' }).expect(201));
    await owner.put(`/workflow/workflows/${pendants}/steps`, { steps: workflowSteps(castingStep('wax_casting', 'Wax casting', {})) }).expect(200);
    await owner.put(`/workflow/products/${pendant}/workflow`, { workflow_id: pendants }).expect(200);

    await owner.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    const luna = id(await owner.post('/customers', { name: 'Luna Jewels' }).expect(201));
    await owner.put(`/customers/${luna}/payment-terms`, { terms: 'pay_later' }).expect(200);
    const progressEmails = (on: boolean) =>
      prisma.inTenant(tenant.id, (tx) => tx.plan.updateMany({ where: { isDefault: true }, data: { features: on ? ['progress_emails'] : [] } }));
    await progressEmails(true);

    const quote = async (productId: string, quantity: number) =>
      ((
        await owner
          .post('/pricing/quotes', {
            product_id: productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity,
            file_version_id: cast.versionId,
            customer_id: luna,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote.id;
    const order = async (lines: [string, number][]) =>
      (
        await owner
          .post('/orders', {
            customer_id: luna,
            lines: await Promise.all(lines.map(async ([product, quantity]) => ({ quote_id: await quote(product, quantity) }))),
            address: { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
            shipping_method: 'courier',
          })
          .expect(201)
      ).body as Order;

    const piecesOf = async (groupId: string) =>
      ((await owner.get(`/workflow/work-orders?group_id=${groupId}&limit=100`).expect(200)).body as { data: Piece[] }).data;
    const ids = (pieces: Piece[]) => pieces.map((piece) => piece.id);
    const move = (by: typeof owner, body: object) => by.post('/workflow/moves', body);
    const pass = (by: typeof owner, pieces: Piece[], atStep: string, extra: object = {}) =>
      move(by, { work_order_ids: ids(pieces), at_step: atStep, kind: 'pass', ...extra });
    const inspect = (pieces: Piece[]) => pass(owner, pieces, 'inspection', { answers: [{ item: 'looks_ok', value: true }] });
    const raised = (orderId: string) =>
      prisma.inTenant(tenant.id, (tx) => tx.notification.findMany({ where: { eventKey: 'order.progress', subjectId: orderId } }));

    const first = await order([
      [cast.productId, 10],
      [pendant, 1],
    ]);
    const [ringsGroup, pendantGroup] = first.lines.map((line) => line.group_id) as [string, string];
    const rings = await piecesOf(ringsGroup);

    // --- Done when 3: casting needs the skill "Casting"; the owner always may.
    await pass(member, rings, 'print_pattern').expect(200);
    await pass(member, rings, 'casting_tree').expect(200);
    const refused = await pass(member, rings, 'casting').expect(403);
    expect(detail(refused)).toBe('Moving pieces at Casting needs the skill Casting');
    await member.put(`/users/${memberUser.id}/skills`, { skills: [{ skill_id: castingSkill, expires_on: '2020-01-31' }] }).expect(403);
    await owner.put(`/users/${memberUser.id}/skills`, { skills: [{ skill_id: castingSkill, expires_on: '2020-01-31' }] }).expect(200);
    await pass(member, rings, 'casting').expect(403);
    await pass(owner, rings.slice(0, 1), 'casting').expect(200);
    await owner.put(`/users/${memberUser.id}/skills`, { skills: [{ skill_id: castingSkill, expires_on: null }] }).expect(200);
    await pass(member, rings.slice(1), 'casting').expect(200);

    // --- Done when 4: one email once both lines are cast, none before, none again after a rework.
    const sendDue = () => progress.sendDue(tenant.id, [ringsGroup, pendantGroup]);
    await expect(sendDue()).resolves.toBe(0);
    for (const step of ['print_pattern', 'casting_tree', 'wax_casting']) {
      await pass(owner, await piecesOf(pendantGroup), step).expect(200);
    }
    await expect(sendDue()).resolves.toBe(1);
    expect((await raised(first.id)).map((row) => row.payload)).toEqual([{ number: String(first.number), step: 'Casting' }]);
    await move(owner, { work_order_ids: [rings[0]!.id], at_step: 'polishing', kind: 'fail', defect_id: defects.porosity }).expect(200);
    await pass(owner, rings.slice(0, 1), 'casting').expect(200);
    await expect(sendDue()).resolves.toBe(0);
    await pass(owner, rings, 'polishing').expect(200);

    // --- Done when 1: two of the ten drawn and marked; the rest wait for them, then pass in one move.
    const atInspection = await piecesOf(ringsGroup);
    expect(atInspection.filter((piece) => piece.to_inspect).map((piece) => piece.number)).toEqual([1, 2]);
    const [sample, rest] = [atInspection.slice(0, 2), atInspection.slice(2)];
    const waiting = await pass(owner, rest, 'inspection', { inspected: false }).expect(409);
    expect(detail(waiting)).toBe('Waiting for the sample to pass');
    await inspect(sample).expect(200);
    await pass(owner, rest, 'inspection', { inspected: false }).expect(200);
    const uninspected = await prisma.inTenant(tenant.id, (tx) =>
      tx.transition.findMany({ where: { workOrderId: { in: ids(rest) }, inspected: false }, include: { answers: true } }),
    );
    expect(uninspected).toHaveLength(8);
    expect(uninspected.every((row) => row.kind === 'pass' && row.answers.length === 0)).toBe(true);

    // --- Done when 2: a sample fails, so the batch is inspected in full; a piece back from rework too.
    const batch = id(await owner.post('/workflow/groups', { quote_id: await quote(cast.productId, 10) }).expect(201));
    let pieces = await piecesOf(batch);
    for (const step of ['print_pattern', 'casting_tree', 'casting', 'polishing']) {
      await pass(owner, pieces, step).expect(200);
    }
    pieces = await piecesOf(batch);
    expect(pieces.filter((piece) => piece.to_inspect).map((piece) => piece.number)).toEqual([1, 2]);
    await move(owner, { work_order_ids: [pieces[0]!.id], at_step: 'inspection', kind: 'fail', defect_id: defects.scratch }).expect(200);
    const afterFail = (await piecesOf(batch)).filter((piece) => piece.step?.key === 'inspection');
    expect(afterFail).toHaveLength(9);
    expect(afterFail.every((piece) => piece.to_inspect === true)).toBe(true);
    await pass(owner, afterFail, 'inspection', { inspected: false }).expect(409);
    await pass(owner, [pieces[0]!], 'polishing').expect(200);
    expect((await piecesOf(batch)).find((piece) => piece.id === pieces[0]!.id)).toMatchObject({
      step: { key: 'inspection' },
      to_inspect: true,
    });

    // --- Done when 4, last part: a customer whose plan has no progress emails hears nothing.
    await progressEmails(false);
    const second = await order([[pendant, 1]]);
    for (const step of ['print_pattern', 'casting_tree', 'wax_casting']) {
      await pass(owner, await piecesOf(second.lines[0]!.group_id), step).expect(200);
    }
    await expect(progress.sendDue(tenant.id, [second.lines[0]!.group_id])).resolves.toBe(0);
    expect(await raised(second.id)).toEqual([]);

    // --- Done when 5: the defect rate leaves out the passes nobody inspected.
    await reports.refresh(tenant.id, new Date());
    const dashboard = (await owner.get('/reports/dashboard').expect(200)).body as { current: { production: { defect_rate: number } } };
    const [defectMoves, inspectedMoves, allMoves] = await prisma.inTenant(tenant.id, async (tx) => [
      await tx.transition.count({ where: { kind: { in: ['pass', 'fail'] }, defectId: { not: null } } }),
      await tx.transition.count({ where: { kind: { in: ['pass', 'fail'] }, inspected: true } }),
      await tx.transition.count({ where: { kind: { in: ['pass', 'fail'] } } }),
    ]);
    expect(allMoves - inspectedMoves).toBe(8);
    expect(dashboard.current.production.defect_rate).toBeCloseTo(defectMoves / inspectedMoves, 6);
    expect(dashboard.current.production.defect_rate).not.toBeCloseTo(defectMoves / allMoves, 6);
  });
});
