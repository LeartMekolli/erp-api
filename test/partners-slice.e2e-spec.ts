import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog } from '../src/cli/seed-catalog';
import { seedPricing } from '../src/cli/seed-pricing';
import { seedWorkflows } from '../src/cli/seed-workflows';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { OfferExpiryHandler } from '../src/modules/partners/offer-expiry.handler';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { measuredDesign } from './catalog-fixtures';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'a-long-partner-password';

interface VersionStep {
  key: string;
  name: string;
  step_type: { id: string };
  checklist: object[];
  defects: { defect_id: string; outcome: string; rework_to: string | null }[];
  rework_targets: string[];
  pass: object;
  fail: object;
  customer: object;
}
interface Eligible {
  data: { partner: { id: string; name: string }; cost: string; margin: string; room: { step_key: string; left: number }[] }[];
  ineligible: { partner: { name: string }; reasons: string[] }[];
}
interface Owed {
  jobs: { group_id: string; state: string; amount: string }[];
}

/**
 * The Partners spec's "Done when" 1–10, end to end over HTTP on the demo catalog, pricing and
 * workflows, as staff, the partners' people and Luna's buyer.
 */
describe('partners: the walkthrough', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let expiry: OfferExpiryHandler;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
  });
  type Client = ReturnType<typeof as>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_NOTIFIER)
      .useValue(notifier)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    expiry = moduleRef.get(OfferExpiryHandler);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app?.close();
  });

  it('runs from inviting a partner to a rated job, and keeps the customer from the partners', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await seedCatalog(prisma, tenant.id);
    await seedPricing(prisma, tenant.id);
    await seedWorkflows(prisma, tenant.id);
    const staffUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, staffUser.id)).accessToken);

    const ids = await prisma.inTenant(tenant.id, async (tx) => ({
      steps: new Map((await tx.stepType.findMany()).map((type) => [type.key, type.id])),
      values: new Map((await tx.optionValue.findMany()).map((value) => [value.key, value.id])),
      workflow: (await tx.workflow.findFirstOrThrow({ where: { key: 'cast_metal' } })).id,
      product: (await tx.product.findFirstOrThrow({ where: { key: 'custom_cast_part' } })).id,
      crack: (await tx.defect.findFirstOrThrow({ where: { key: 'crack' } })).id,
    }));
    const step = (key: string) => ids.steps.get(key)!;
    const login = async (email: string) => {
      const response = await http().post('/auth/login').send({ email, password: PASSWORD, workspace: tenant.slug }).expect(200);
      return as((response.body as { access_token: string }).access_token);
    };
    const notifications = (eventKey: string) => prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey } }));

    // Packing is done in-house, so final QC is where partners are owed.
    const workflowPath = `/workflow/workflows/${ids.workflow}`;
    const current = ((await staff.get(workflowPath).expect(200)).body as { current_version: { steps: VersionStep[] } }).current_version;
    await staff
      .put(`${workflowPath}/steps`, {
        steps: current.steps.map((one) => ({
          key: one.key,
          name: one.name,
          step_type_id: one.step_type.id,
          checklist: one.checklist,
          defects: one.defects.map(({ defect_id, outcome, rework_to }) => ({ defect_id, outcome, ...(rework_to ? { rework_to } : {}) })),
          rework_targets: one.rework_targets,
          pass: one.pass,
          fail: one.fail,
          customer: one.customer,
          done_by: one.key === 'packing' ? 'workspace' : 'partner',
        })),
      })
      .expect(200);

    // 1. Staff create CastCo and invite its owner, who accepts and logs in to the partner portal.
    const partner = async (name: string, email: string) => {
      const id = ((await staff.post('/partners', { name: `${name} Ltd`, display_name: name }).expect(201)).body as { id: string }).id;
      await staff.post(`/partners/${id}/invitations`, { email, role: 'owner' }).expect(201);
      const token = notifier.lastPartnerInvitationFor(email)!.token;
      await http().post('/auth/partner-invitations/accept').send({ token, name, password: PASSWORD }).expect(204);
      const person = await login(email);
      const me = (await person.get('/partner-portal/me').expect(200)).body as { partners: { id: string; status: string }[] };
      expect(me.partners).toEqual([expect.objectContaining({ id, status: 'setting_up' })]);
      return { id, person, portal: `/partner-portal/partners/${id}` };
    };
    const castco = await partner('CastCo', 'ana@castco.example.test');

    // 2. CastCo sets itself up, and staff approve it with its signed agreement.
    const setUp = async (who: { id: string; person: Client; portal: string }, steps: string[], castingSetup: string, direct: boolean) => {
      await who.person
        .put(`${who.portal}/capabilities`, {
          capabilities: steps.map((key) => ({
            step_type_id: step(key),
            capacity: 200,
            capacity_period: 'week',
            ...(key === 'casting' ? { max_size_mm: '40', max_quantity: 500 } : {}),
          })),
        })
        .expect(200);
      await who.person.put(`${who.portal}/offerings`, { option_value_ids: [ids.values.get('silver_925'), ids.values.get('polished')] }).expect(200);
      // Staff start its prices from the workspace's; it sets its own casting price before submitting.
      await staff.post(`/partners/${who.id}/prices/copy-from-workspace`).expect(200);
      await who.person
        .put(`${who.portal}/step-types/${step('casting')}/prices`, {
          failure_percent: '0',
          blocks: [
            { kind: 'material', source: { configuration: true }, basis: 'weight', loss_percent: '5' },
            { kind: 'setup', amount: castingSetup },
          ],
        })
        .expect(200);
      if (direct) await who.person.patch(`${who.portal}/limits`, { accepts_direct_orders: true }).expect(200);
      await who.person.post(`${who.portal}/submit`).expect(200);
      const agreement = (await measuredDesign(prisma, tenant.id, staffUser.id, { status: 'uploaded', measures: [] })).versionId;
      await staff.put(`/partners/${who.id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${who.id}/approve`).expect(200);
    };
    const castLine = ['print_pattern', 'casting_tree', 'casting', 'polishing', 'final_qc'];
    await setUp(castco, castLine, '30', false);

    // 3. MetalWorks the same, dearer for casting and taking direct orders; PrintLab doesn't polish.
    const metalworks = await partner('MetalWorks', 'max@metalworks.example.test');
    await setUp(metalworks, castLine, '50', true);
    const printlab = await partner('PrintLab', 'pia@printlab.example.test');
    await setUp(printlab, castLine.filter((key) => key !== 'polishing'), '30', false);

    // Luna, with a buyer, and her design.
    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    await staff.post(`/customers/${luna}/invitations`, { email: 'ben@luna.example.test', role: 'buyer' }).expect(201);
    const benToken = notifier.lastCustomerInvitationFor('ben@luna.example.test')!.token;
    await http().post('/auth/customer-invitations/accept').send({ token: benToken, name: 'Ben', password: PASSWORD }).expect(204);
    const ben = await login('ben@luna.example.test');
    const design = (await measuredDesign(prisma, tenant.id, staffUser.id, { customerId: luna })).versionId;
    const configuration = { product_id: ids.product, options: { material: 'silver_925', finish: 'polished' }, size: { scale: '1.5' }, quantity: 10 };
    const job = async () => {
      const quoted = await staff.post('/pricing/quotes', { ...configuration, file_version_id: design, customer_id: luna }).expect(201);
      const quote = (quoted.body as { quote: { id: string; total: string } }).quote;
      const group = ((await staff.post('/workflow/groups', { quote_id: quote.id }).expect(201)).body as { id: string }).id;
      return { group, quote };
    };

    // 4. For 10 polished silver rings: CastCo and MetalWorks can take it, with cost, margin and room; PrintLab can't.
    const rings = await job();
    const spare = await job();
    const eligible = async (group: string) => (await staff.get(`/partners/eligible?group_id=${group}`).expect(200)).body as Eligible;
    let options = await eligible(rings.group);
    expect(options.data.map((row) => row.partner.id)).toEqual([castco.id, metalworks.id]);
    expect(options.ineligible.map((row) => row.partner.name)).toEqual(['PrintLab Ltd']);
    expect(options.data[0].room.length).toBeGreaterThan(0);
    const castingRoom = async (group: string) =>
      (await eligible(group)).data.find((row) => row.partner.id === castco.id)!.room.find((room) => room.step_key === 'casting')!.left;

    // 5. Offering it to CastCo takes 10 of CastCo's room; CastCo declines, staff hear of it; offered again, CastCo accepts.
    const before = await castingRoom(spare.group);
    await staff.post(`/partners/jobs/${rings.group}/offer`, { partner_id: castco.id }).expect(201);
    expect(await castingRoom(spare.group)).toBe(before - 10);
    await castco.person.post(`${castco.portal}/jobs/${rings.group}/decline`).expect(200);
    expect(await notifications('partner.job.declined')).toBe(1);
    expect(await castingRoom(spare.group)).toBe(before);
    await staff.post(`/partners/jobs/${rings.group}/offer`, { partner_id: castco.id }).expect(201);
    await castco.person.post(`${castco.portal}/jobs/${rings.group}/accept`).expect(200);

    // 6. CastCo moves the rings behind the QC gate, never seeing Luna or her price; packing is the workspace's.
    const pieces = async () =>
      ((await castco.person.get(`${castco.portal}/jobs/${rings.group}`).expect(200)).body as { work_orders: { id: string; status: string; step_key: string | null }[] })
        .work_orders;
    const moves = `${castco.portal}/moves`;
    const photo = (await measuredDesign(prisma, tenant.id, staffUser.id, { status: 'uploaded', measures: [] })).versionId;
    const answers: Record<string, object> = {
      polishing: { answers: [{ item: 'surface', value: 'ok' }] },
      final_qc: { answers: [{ item: 'dimensions', value: true }], photo_file_version_ids: [photo] },
    };
    const pass = (who: Client, path: string, workOrderIds: string[], keys: string[]) =>
      keys.reduce(
        (previous, at_step) =>
          previous.then(async () => {
            await who.post(path, { work_order_ids: workOrderIds, kind: 'pass', at_step, ...(answers[at_step] ?? {}) }).expect(200);
          }),
        Promise.resolve(),
      );

    let ringIds = (await pieces()).map((piece) => piece.id);
    await pass(castco.person, moves, ringIds, ['print_pattern', 'casting_tree']);
    // 7 (part). Ring 1 cracks at casting: scrapped, and remade at CastCo's own cost.
    await castco.person.post(moves, { work_order_ids: [ringIds[0]], kind: 'fail', at_step: 'casting', defect_id: ids.crack }).expect(200);
    const remade = (await pieces()).find((piece) => piece.status === 'active' && piece.step_key === 'print_pattern')!;
    await pass(castco.person, moves, [remade.id], ['print_pattern', 'casting_tree']);
    ringIds = (await pieces()).filter((piece) => piece.status === 'active').map((piece) => piece.id);
    await pass(castco.person, moves, ringIds, ['casting', 'polishing', 'final_qc']);
    await castco.person.post(moves, { work_order_ids: ringIds, kind: 'pass', at_step: 'packing' }).expect(409);

    const seen = [
      (await castco.person.get(`${castco.portal}/jobs`).expect(200)).text,
      (await castco.person.get(`${castco.portal}/jobs/${rings.group}`).expect(200)).text,
    ].join('\n');
    for (const secret of [luna, 'Luna Jewels', rings.quote.id, rings.quote.total]) {
      expect({ secret, found: seen.includes(secret) }).toEqual({ secret, found: false });
    }

    // 7. Every ring past final QC: CastCo is owed its cost, scrap and all; a correction takes it back, passing again restores it.
    const assignment = ((await staff.get(`/partners/jobs/${rings.group}`).expect(200)).body as { data: { status: string; cost: string }[] }).data.at(-1)!;
    const owed = async () => ((await staff.get(`/partners/${castco.id}/owed`).expect(200)).body as Owed).jobs.find((one) => one.group_id === rings.group)!;
    expect(await owed()).toMatchObject({ state: 'owed', amount: assignment.cost });
    await staff
      .post('/workflow/moves', { work_order_ids: [ringIds[2]], kind: 'correction', to_step: 'polishing', comment: 'Back for a polish' })
      .expect(200);
    expect((await owed()).state).toBe('not_yet');
    await pass(castco.person, moves, [ringIds[2]], ['polishing', 'final_qc']);
    expect(await owed()).toMatchObject({ state: 'owed', amount: assignment.cost });
    await staff.post('/workflow/moves', { work_order_ids: ringIds, kind: 'pass', at_step: 'packing' }).expect(200);

    // 8. Luna, allowed to pick, sees only MetalWorks at its own price, quotes with it, and the started job is MetalWorks's at once.
    await staff.patch(`/customers/${luna}`, { may_pick_partner: true }).expect(200);
    const lunaQuotes = `/portal/customers/${luna}/quotes`;
    const choices = (await ben.post(`${lunaQuotes}/partners`, { ...configuration, file_version_id: design }).expect(200)).body as {
      data: { partner: { id: string; display_name: string }; price: { total: string } }[];
    };
    expect(choices.data.map((choice) => choice.partner.display_name)).toEqual(['MetalWorks']);
    const picked = await ben.post(lunaQuotes, { ...configuration, file_version_id: design, partner_id: metalworks.id }).expect(201);
    const pickedQuote = (picked.body as { quote: { id: string; total: string } }).quote;
    expect(pickedQuote.total).toBe(choices.data[0].price.total);
    const direct = ((await staff.post('/workflow/groups', { quote_id: pickedQuote.id }).expect(201)).body as { id: string }).id;
    expect(((await staff.get(`/partners/jobs/${direct}`).expect(200)).body as { data: object[] }).data).toEqual([
      expect.objectContaining({ kind: 'direct', status: 'accepted', partner: expect.objectContaining({ id: metalworks.id }) }),
    ]);
    const metalworksJobs = ((await metalworks.person.get(`${metalworks.portal}/jobs`).expect(200)).body as { data: { id: string; status: string }[] }).data;
    expect(metalworksJobs).toEqual([expect.objectContaining({ id: direct, status: 'accepted' })]);

    // 9. An offer left unanswered past its deadline expires on its own and frees CastCo's room.
    const roomBefore = await castingRoom(rings.group);
    const offered = (await staff.post(`/partners/jobs/${spare.group}/offer`, { partner_id: castco.id }).expect(201)).body as { id: string };
    expect(await castingRoom(rings.group)).toBe(roomBefore - 10);
    await prisma.inTenant(tenant.id, (tx) =>
      tx.jobAssignment.update({ where: { id: offered.id }, data: { expiresAt: new Date(Date.now() - 1_000) } }),
    );
    await expiry.handle();
    expect(((await staff.get(`/partners/jobs/${spare.group}`).expect(200)).body as { data: { status: string }[] }).data.map((row) => row.status)).toEqual([
      'expired',
    ]);
    expect(await notifications('partner.job.expired')).toBe(1);
    expect(await castingRoom(rings.group)).toBe(roomBefore);

    // 10. Ben rates the finished rings; the score shows its parts; CastCo sees the stars, and the comment once staff share it, never Luna.
    const comment = 'Beautiful rings, thank you from Luna';
    await ben.post(`/portal/customers/${luna}/jobs/${rings.group}/rating`, { stars: 4, comment }).expect(201);
    const score = ((await staff.get(`/partners/${castco.id}`).expect(200)).body as { score: { overall: number | null; parts: Record<string, number | null> } })
      .score;
    // One finished job: still "new", but every part with data shows.
    expect(score.overall).toBeNull();
    for (const part of ['quality', 'scrap', 'reliability', 'rating']) {
      expect({ part, value: typeof score.parts[part] }).toEqual({ part, value: 'number' });
    }
    expect(score.parts.rating).toBeCloseTo(0.75);

    const mine = async () => castco.person.get(`${castco.portal}/score`).expect(200);
    let view = await mine();
    expect((view.body as { ratings: { stars: number; comment: string | null }[] }).ratings).toEqual([
      expect.objectContaining({ stars: 4, comment: null }),
    ]);
    const rating = ((await staff.get(`/partners/${castco.id}/ratings`).expect(200)).body as { data: { id: string; comment: string }[] }).data[0];
    expect(rating.comment).toBe(comment);
    await staff.post(`/partners/ratings/${rating.id}/share`).expect(200);
    view = await mine();
    expect((view.body as { ratings: { comment: string | null }[] }).ratings[0].comment).toBe(comment);
    for (const secret of [luna, 'Luna Jewels', 'Ben']) {
      expect({ secret, found: view.text.includes(secret) }).toEqual({ secret, found: false });
    }
  });
});
