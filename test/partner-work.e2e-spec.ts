import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { JobsService as QueueJobsService } from '../src/jobs/jobs.service';
import { downloadUrlResponseSchema } from '../src/modules/files/file-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import {
  partnerJobDetailResponseSchema,
  partnerJobResponseSchema,
  partnerJobsResponseSchema,
} from '../src/modules/partners/partner-response';
import { ReworkNoticeService } from '../src/modules/partners/rework-notice.service';
import { moveResponseSchema, transitionListItemSchema, workOrderDetailResponseSchema } from '../src/modules/workflow/work-order-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { putToSignedUrl } from './storage';

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
interface PartnerJob {
  id: string;
  status: string;
  quantity: number;
  steps: { key: string }[];
  pieces: { active: number; finished: number; scrapped: number };
  work_orders?: { id: string; label: string; status: string; step_key: string | null; to_inspect: boolean | null; stage: string | null }[];
}
interface PartnerStep {
  key: string;
  sop_file_version_id: string | null;
  checklist: object[];
  defects: object[];
  rework_targets: { key: string; name: string }[];
  pass: object;
  fail: object;
  sampling: object | null;
}
interface Transition {
  kind: string;
  from_step: { key: string } | null;
  partner: { id: string; name: string } | null;
  photos: { file_id: string; file_version_id: string }[];
}

/** Not a real image: storage checks only the declared size and type. */
const PHOTO_BYTES = Buffer.from('a QC photo of the pieces');

/**
 * Partners at work (Partners spec, goal 13; plan Review Focus 2): a partner sees the jobs it was
 * offered or accepted, never the customer, and moves its pieces through its own steps behind the
 * same QC gate as staff. Each move records the partner it counts for.
 */
describe('partners: working their jobs', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none, so silver is at its fallback.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });
  type Person = ReturnType<typeof as>;

  async function partnerPerson(tenantId: string, partnerId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind: 'partner' } });
      await tx.organisationMembership.create({
        data: { userId: user.id, organisationType: 'partner', organisationId: partnerId, role },
      });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /**
   * The priced cast part, with packing done in-house; CastCo and MetalWorks approved for the partner
   * steps; Luna's two jobs of 10 silver polished pieces, the first accepted by CastCo, the second only
   * offered to it. `overrides` changes steps by key before the jobs are made; `sopVersionId` makes a
   * file in the workspace to use as a step's instructions.
   */
  async function freshTenant(overrides?: (sopVersionId: () => Promise<string>) => Promise<Record<string, object>>) {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    const { printPattern, castingTree, casting, polishing } = cast.steps;
    let sop: string | null = null;
    const changes = overrides
      ? await overrides(async () => {
          sop = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
          return sop;
        })
      : {};

    // The same steps again, with packing done by the workspace.
    const workflowPath = `/workflow/workflows/${cast.workflow.workflowId}`;
    const current = ((await staff.get(workflowPath).expect(200)).body as { current_version: { steps: VersionStep[] } }).current_version;
    await staff
      .put(`${workflowPath}/steps`, {
        steps: current.steps.map((step) => ({
          key: step.key,
          name: step.name,
          step_type_id: step.step_type.id,
          checklist: step.checklist,
          defects: step.defects.map(({ defect_id, outcome, rework_to }) => ({ defect_id, outcome, ...(rework_to ? { rework_to } : {}) })),
          rework_targets: step.rework_targets,
          pass: step.pass,
          fail: step.fail,
          customer: step.customer,
          done_by: step.key === 'packing' ? 'workspace' : 'partner',
          ...changes[step.key],
        })),
      })
      .expect(200);

    const partner = async (name: string) => {
      const id = ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
      await staff
        .put(`/partners/${id}/capabilities`, {
          capabilities: [printPattern, castingTree, casting, polishing, cast.workflow.notPriced.finalQc].map((step_type_id) => ({
            step_type_id,
            capacity: 200,
            capacity_period: 'week',
          })),
        })
        .expect(200);
      await staff.put(`/partners/${id}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
      await staff.post(`/partners/${id}/prices/copy-from-workspace`).expect(200);
      const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return id;
    };
    const castco = await partner('CastCo');
    const metalworks = await partner('MetalWorks');
    const castcoPerson = await partnerPerson(tenant.id, castco, 'member');

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const job = async () => {
      const quoted = await staff
        .post('/pricing/quotes', {
          product_id: cast.productId,
          options: { material: 'silver_925', finish: 'polished' },
          size: { scale: '1.5' },
          file_version_id: cast.versionId,
          quantity: 10,
          customer_id: luna,
        })
        .expect(201);
      const quote = (quoted.body as { quote: { id: string; total: string; unit_price: string } }).quote;
      const group = ((await staff.post('/workflow/groups', { quote_id: quote.id }).expect(201)).body as { id: string }).id;
      await staff.post(`/partners/jobs/${group}/offer`, { partner_id: castco }).expect(201);
      return { group, quote };
    };
    const accepted = await job();
    await castcoPerson.post(`/partner-portal/partners/${castco}/jobs/${accepted.group}/accept`).expect(200);
    const offered = await job();

    return {
      id: tenant.id,
      ownerId: owner.id,
      staff,
      cast,
      castco,
      metalworks,
      luna,
      accepted,
      offered,
      castcoPerson,
      metalworksPerson: await partnerPerson(tenant.id, metalworks, 'member'),
      sop: sop as string | null,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const portal = (tenant: Tenant) => `/partner-portal/partners/${tenant.castco}`;
  const pieces = async (tenant: Tenant, group: string) => {
    const detail = await tenant.castcoPerson.get(`${portal(tenant)}/jobs/${group}`).expect(200);
    expectDocumented(partnerJobDetailResponseSchema, detail.body);
    return (detail.body as PartnerJob).work_orders!;
  };
  const surfaceOk = [{ item: 'surface', value: 'ok' }];

  /** A photo the partner uploads through its own file routes, completed. */
  async function partnerPhoto(person: Person, partnerId: string): Promise<{ fileId: string; versionId: string }> {
    const files = `/partner-portal/partners/${partnerId}/files`;
    const started = await person.post(files, { name: 'qc.jpg', content_type: 'image/jpeg', size: PHOTO_BYTES.length }).expect(201);
    const { file, version, upload } = started.body as {
      file: { id: string };
      version: { id: string };
      upload: { url: string; headers: Record<string, string> };
    };
    const put = await putToSignedUrl(upload.url, PHOTO_BYTES, upload.headers);
    await put.arrayBuffer();
    expect(put.status).toBe(200);
    await person.post(`${files}/${file.id}/versions/${version.id}/complete`).expect(200);
    return { fileId: file.id, versionId: version.id };
  }

  /** Passes the pieces through every partner step before final QC. */
  async function toFinalQc(tenant: Tenant, ids: string[]): Promise<void> {
    const moves = `${portal(tenant)}/moves`;
    for (const at_step of ['print_pattern', 'casting_tree', 'casting']) {
      await tenant.castcoPerson.post(moves, { work_order_ids: ids, kind: 'pass', at_step }).expect(200);
    }
    await tenant.castcoPerson.post(moves, { work_order_ids: ids, kind: 'pass', at_step: 'polishing', answers: surfaceOk }).expect(200);
  }

  beforeAll(async () => {
    // Its own queues: no other suite's worker takes this one's measuring jobs.
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('shows a partner its jobs and what to make, never the customer', async () => {
    const tenant = await freshTenant();

    const listed = await tenant.castcoPerson.get(`${portal(tenant)}/jobs`).expect(200);
    const jobs = (listed.body as { data: PartnerJob[] }).data;
    jobs.forEach((job) => expectDocumented(partnerJobResponseSchema, job));
    expect(jobs.map((job) => [job.id, job.status])).toEqual([
      [tenant.offered.group, 'offered'],
      [tenant.accepted.group, 'accepted'],
    ]);
    const accepted = jobs[1];
    expect(accepted).toMatchObject({
      quantity: 10,
      options: [
        { group: 'material', value: 'silver_925' },
        { group: 'finish', value: 'polished' },
      ],
      design_file_version_id: tenant.cast.versionId,
      pieces: { active: 10, finished: 0, scrapped: 0 },
    });
    // Only the partner's steps: packing is done in-house.
    expect(accepted.steps.map((step) => step.key)).toEqual(['print_pattern', 'casting_tree', 'casting', 'polishing', 'final_qc']);

    expectDocumented(partnerJobsResponseSchema, listed.body);
    expect((listed.body as { next_cursor: string | null }).next_cursor).toBeNull();

    // A page at a time, newest hand-over first.
    const first = await tenant.castcoPerson.get(`${portal(tenant)}/jobs?limit=1`).expect(200);
    expectDocumented(partnerJobsResponseSchema, first.body);
    const firstPage = first.body as { data: PartnerJob[]; next_cursor: string | null };
    expect(firstPage.data.map((job) => job.id)).toEqual([tenant.offered.group]);
    expect(firstPage.next_cursor).toEqual(expect.any(String));
    const second = await tenant.castcoPerson.get(`${portal(tenant)}/jobs?limit=1&cursor=${firstPage.next_cursor}`).expect(200);
    expectDocumented(partnerJobsResponseSchema, second.body);
    expect((second.body as { data: PartnerJob[] }).data.map((job) => job.id)).toEqual([tenant.accepted.group]);
    expect((second.body as { next_cursor: string | null }).next_cursor).toBeNull();

    // The status filter applies before paging: one offered job is a full page, with nothing after it.
    const offeredOnly = await tenant.castcoPerson.get(`${portal(tenant)}/jobs?status=offered&limit=1`).expect(200);
    expectDocumented(partnerJobsResponseSchema, offeredOnly.body);
    expect((offeredOnly.body as { data: PartnerJob[] }).data.map((job) => job.id)).toEqual([tenant.offered.group]);
    expect((offeredOnly.body as { next_cursor: string | null }).next_cursor).toBeNull();
    const acceptedOnly = await tenant.castcoPerson.get(`${portal(tenant)}/jobs?status=accepted&limit=1`).expect(200);
    expect((acceptedOnly.body as { data: PartnerJob[] }).data.map((job) => job.id)).toEqual([tenant.accepted.group]);
    await tenant.castcoPerson.get(`${portal(tenant)}/jobs?status=lost`).expect(400);

    const detail = await tenant.castcoPerson.get(`${portal(tenant)}/jobs/${tenant.accepted.group}`).expect(200);
    expect((detail.body as PartnerJob).work_orders!.map((piece) => [piece.label, piece.step_key, piece.to_inspect])).toEqual(
      Array.from({ length: 10 }, (_, index) => [`${index + 1}/10`, 'print_pattern', null]),
    );

    // Review Focus 2: nothing of the customer or the customer's price, anywhere in what the partner gets.
    for (const body of [listed.text, detail.text]) {
      for (const secret of [tenant.luna, 'Luna Jewels', tenant.accepted.quote.id, tenant.offered.quote.id, tenant.accepted.quote.total, tenant.accepted.quote.unit_price]) {
        expect({ secret, found: body.includes(secret) }).toEqual({ secret, found: false });
      }
    }

    const design = await tenant.castcoPerson.get(`${portal(tenant)}/jobs/${tenant.accepted.group}/design`).expect(200);
    expectDocumented(downloadUrlResponseSchema, design.body);
    expect((design.body as { url: string }).url).toMatch(/^https?:\/\//);
    // The design comes with the job, not with the offer: a partner that may still decline doesn't get it.
    await tenant.castcoPerson.get(`${portal(tenant)}/jobs/${tenant.offered.group}/design`).expect(404);

    // Not MetalWorks' job, nor an unknown one.
    await tenant.metalworksPerson.get(`/partner-portal/partners/${tenant.metalworks}/jobs/${tenant.accepted.group}`).expect(404);
    await tenant.metalworksPerson.get(`/partner-portal/partners/${tenant.metalworks}/jobs/${tenant.accepted.group}/design`).expect(404);
    expect(((await tenant.metalworksPerson.get(`/partner-portal/partners/${tenant.metalworks}/jobs`).expect(200)).body as { data: unknown[] }).data).toEqual([]);
  });

  it("gives a partner its steps' QC rules, the pieces to inspect and each step's instructions", async () => {
    const tenant = await freshTenant(async (sopVersionId) => {
      const sop = await sopVersionId();
      return {
        print_pattern: { sampling: { inspect: 1, of_every: 10 }, sop_file_version_id: sop },
        polishing: { done_by: 'workspace' },
        packing: { done_by: 'workspace', sop_file_version_id: sop },
      };
    });
    const sop = tenant.sop!;
    const { defects } = tenant.cast.workflow;

    const detail = await tenant.castcoPerson.get(`${portal(tenant)}/jobs/${tenant.accepted.group}`).expect(200);
    expectDocumented(partnerJobDetailResponseSchema, detail.body);
    const job = detail.body as PartnerJob & { steps: PartnerStep[] };
    // Polishing and packing are in-house.
    expect(job.steps.map((step) => step.key)).toEqual(['print_pattern', 'casting_tree', 'casting', 'final_qc']);
    expect(job.steps[0]).toMatchObject({ sop_file_version_id: sop, sampling: { inspect: 1, of_every: 10 }, checklist: [] });
    expect(job.steps.find((step) => step.key === 'casting')).toMatchObject({
      defects: [
        { id: defects.porosity, key: 'porosity', name: 'Porosity', outcome: 'rework', rework_to: 'casting' },
        { id: defects.crack, key: 'crack', name: 'Crack', outcome: 'scrap', rework_to: null },
      ],
      rework_targets: [{ key: 'casting', name: 'Casting' }],
      sampling: null,
    });
    expect(job.steps.find((step) => step.key === 'final_qc')).toMatchObject({
      checklist: [{ key: 'weight', kind: 'number', unit: 'g', min: '4.8', max: '5.2', required: true }],
      pass: { min_photos: 1, comment_required: false },
      // Polishing is the workspace's: named, never its rules.
      rework_targets: [{ key: 'polishing', name: 'Polishing' }],
      defects: [{ id: defects.scratch, key: 'scratch', name: 'Scratch', outcome: 'rework', rework_to: 'polishing' }],
    });
    // No staff-only settings, and nothing of the in-house steps' checks.
    for (const secret of ['required_skill_id', 'expected_minutes', 'done_by', 'step_type', '"customer"', '"surface"']) {
      expect({ secret, found: detail.text.includes(secret) }).toEqual({ secret, found: false });
    }

    // One of every ten pieces at the sampling step is drawn, and the QC gate agrees.
    const drawn = job.work_orders!.filter((piece) => piece.to_inspect === true).map((piece) => piece.id);
    const leftOut = job.work_orders!.filter((piece) => piece.to_inspect === false).map((piece) => piece.id);
    expect([drawn.length, leftOut.length]).toEqual([1, 9]);
    const uninspected = (ids: string[]) => ({ work_order_ids: ids, kind: 'pass', at_step: 'print_pattern', inspected: false });
    await tenant.castcoPerson.post(`${portal(tenant)}/moves`, uninspected(drawn)).expect(409);
    // The rest go through without inspection once the drawn piece has passed in full.
    await tenant.castcoPerson.post(`${portal(tenant)}/moves`, { work_order_ids: drawn, kind: 'pass', at_step: 'print_pattern' }).expect(200);
    await tenant.castcoPerson.post(`${portal(tenant)}/moves`, uninspected(leftOut)).expect(200);

    const instructions = (group: string, key: string) => `${portal(tenant)}/jobs/${group}/steps/${key}/sop`;
    const link = await tenant.castcoPerson.get(instructions(tenant.accepted.group, 'print_pattern')).expect(200);
    expectDocumented(downloadUrlResponseSchema, link.body);
    expect((link.body as { url: string }).url).toMatch(/^https?:\/\//);
    // Only offered, no instructions, the workspace's step, an unknown step, another partner.
    await tenant.castcoPerson.get(instructions(tenant.offered.group, 'print_pattern')).expect(404);
    await tenant.castcoPerson.get(instructions(tenant.accepted.group, 'casting')).expect(404);
    await tenant.castcoPerson.get(instructions(tenant.accepted.group, 'packing')).expect(404);
    await tenant.castcoPerson.get(instructions(tenant.accepted.group, 'nope')).expect(404);
    await tenant.metalworksPerson
      .get(`/partner-portal/partners/${tenant.metalworks}/jobs/${tenant.accepted.group}/steps/print_pattern/sop`)
      .expect(404);
  });

  it('says where each piece stands: with the partner, not with it yet, or its part done', async () => {
    const tenant = await freshTenant(async () => ({ casting_tree: { done_by: 'workspace' }, final_qc: { done_by: 'workspace' } }));
    const moves = `${portal(tenant)}/moves`;
    const stages = async () => (await pieces(tenant, tenant.accepted.group)).map((piece) => piece.stage);

    expect(await stages()).toEqual(Array(10).fill('yours'));
    const ids = (await pieces(tenant, tenant.accepted.group)).map((piece) => piece.id);

    // The casting tree is the workspace's, between two of the partner's steps.
    await tenant.castcoPerson.post(moves, { work_order_ids: ids, kind: 'pass', at_step: 'print_pattern' }).expect(200);
    expect(await stages()).toEqual(Array(10).fill('not_yet'));

    await tenant.staff.post('/workflow/moves', { work_order_ids: ids, kind: 'pass', at_step: 'casting_tree' }).expect(200);
    await tenant.castcoPerson.post(moves, { work_order_ids: ids.slice(0, 3), kind: 'pass', at_step: 'casting' }).expect(200);
    await tenant.castcoPerson.post(moves, { work_order_ids: ids.slice(0, 3), kind: 'pass', at_step: 'polishing', answers: surfaceOk }).expect(200);
    // Final QC and packing are the workspace's, and nothing of the partner's is left after them.
    expect(await stages()).toEqual([...Array(3).fill('done'), ...Array(7).fill('yours')]);
  });

  it("lists a job as finished once the partner's part is done, and accepted again when a piece comes back", async () => {
    const tenant = await freshTenant(async () => ({ final_qc: { done_by: 'workspace' } }));
    const moves = `${portal(tenant)}/moves`;
    const ids = (await pieces(tenant, tenant.accepted.group)).map((piece) => piece.id);
    for (const at_step of ['print_pattern', 'casting_tree', 'casting']) {
      await tenant.castcoPerson.post(moves, { work_order_ids: ids, kind: 'pass', at_step }).expect(200);
    }
    await tenant.castcoPerson.post(moves, { work_order_ids: ids, kind: 'pass', at_step: 'polishing', answers: surfaceOk }).expect(200);

    const statusOf = async () => {
      const listed = await tenant.castcoPerson.get(`${portal(tenant)}/jobs`).expect(200);
      expectDocumented(partnerJobsResponseSchema, listed.body);
      return (listed.body as { data: PartnerJob[] }).data.find((job) => job.id === tenant.accepted.group)!.status;
    };
    const filtered = async (status: string) =>
      ((await tenant.castcoPerson.get(`${portal(tenant)}/jobs?status=${status}`).expect(200)).body as { data: PartnerJob[] }).data.map((job) => job.id);

    // Every piece waits at the workspace's final QC: active, but the partner's part is done.
    expect((await pieces(tenant, tenant.accepted.group)).map((piece) => piece.stage)).toEqual(Array(10).fill('done'));
    expect(await statusOf()).toBe('finished');
    expect(await filtered('finished')).toEqual([tenant.accepted.group]);
    expect(await filtered('accepted')).toEqual([]);

    // Staff send one back to polishing: the job is the partner's again.
    await tenant.staff
      .post('/workflow/moves', { work_order_ids: [ids[0]], kind: 'correction', to_step: 'polishing', comment: 'Back for a polish' })
      .expect(200);
    expect((await pieces(tenant, tenant.accepted.group))[0].stage).toBe('yours');
    expect(await statusOf()).toBe('accepted');
    expect(await filtered('accepted')).toEqual([tenant.accepted.group]);
    expect(await filtered('finished')).toEqual([]);
  });

  it('tells the partner when pieces it finished come back', async () => {
    // No worker runs here: the test reads what a move queued and runs the notice as the job would.
    const enqueue = jest.spyOn(app.get(QueueJobsService), 'enqueue');
    try {
      const tenant = await freshTenant(async () => ({ final_qc: { done_by: 'workspace' } }));
      const moves = `${portal(tenant)}/moves`;
      const ids = (await pieces(tenant, tenant.accepted.group)).map((piece) => piece.id);
      for (const at_step of ['print_pattern', 'casting_tree', 'casting']) {
        await tenant.castcoPerson.post(moves, { work_order_ids: ids, kind: 'pass', at_step }).expect(200);
      }
      await tenant.castcoPerson.post(moves, { work_order_ids: ids, kind: 'pass', at_step: 'polishing', answers: surfaceOk }).expect(200);
      const queued = () =>
        enqueue.mock.calls.filter(([name]) => name === 'partners.rework_notice').map(([, payload]) => payload as { tenantId: string; groupIds: string[]; moveId: string });
      const notices = () => prisma.inTenant(tenant.id, (tx) => tx.notification.findMany({ where: { eventKey: 'partner.job.reworked' } }));
      // Review Focus 14: a pass never sends a piece back.
      expect(queued()).toEqual([]);

      // Staff send two finished pieces back from the workspace's final QC to polishing.
      await tenant.staff
        .post('/workflow/moves', { work_order_ids: ids.slice(0, 2), kind: 'correction', to_step: 'polishing', comment: 'Back for a polish' })
        .expect(200);
      const [sentBack] = queued();
      expect(sentBack).toMatchObject({ tenantId: tenant.id, groupIds: [tenant.accepted.group] });
      await app.get(ReworkNoticeService).notify(sentBack.tenantId, sentBack.moveId);
      const held = await prisma.inTenant(tenant.id, (tx) =>
        tx.jobAssignment.findFirstOrThrow({ where: { groupId: tenant.accepted.group, partnerId: tenant.castco, status: 'accepted' } }),
      );
      const [notice] = await notices();
      expect(notice).toMatchObject({ subjectType: 'job_assignment', subjectId: held.id, payload: { pieces: '2', quantity: '10' } });

      // A correction between the partner's own steps sends nothing back: no notice.
      await tenant.staff
        .post('/workflow/moves', { work_order_ids: [ids[0]], kind: 'correction', to_step: 'casting', comment: 'Recast it' })
        .expect(200);
      const [, withinPartner] = queued();
      await app.get(ReworkNoticeService).notify(withinPartner.tenantId, withinPartner.moveId);
      expect(await notices()).toHaveLength(1);
    } finally {
      enqueue.mockRestore();
    }
  });

  it("keeps the workspace's own sampling from the partner", async () => {
    const tenant = await freshTenant(async () => ({ print_pattern: { done_by: 'workspace', sampling: { inspect: 1, of_every: 10 } } }));
    const detail = await tenant.castcoPerson.get(`${portal(tenant)}/jobs/${tenant.accepted.group}`).expect(200);
    expectDocumented(partnerJobDetailResponseSchema, detail.body);
    const job = detail.body as PartnerJob;
    expect(job.steps.map((step) => step.key)).not.toContain('print_pattern');
    // Every piece is at the workspace's sampling step: none says whether it was drawn.
    expect(job.work_orders!.map((piece) => [piece.step_key, piece.to_inspect])).toEqual(Array.from({ length: 10 }, () => ['print_pattern', null]));
  });

  it("moves the partner's pieces through its own steps behind the QC gate, and records the partner on each move", async () => {
    const tenant = await freshTenant();
    const moves = `${portal(tenant)}/moves`;
    const ids = (await pieces(tenant, tenant.accepted.group)).map((piece) => piece.id);

    for (const at_step of ['print_pattern', 'casting_tree', 'casting']) {
      const moved = await tenant.castcoPerson.post(moves, { work_order_ids: ids, kind: 'pass', at_step }).expect(200);
      expectDocumented(moveResponseSchema, moved.body);
    }
    // The same gate as staff: polishing needs its surface answer.
    await tenant.castcoPerson.post(moves, { work_order_ids: ids, kind: 'pass', at_step: 'polishing' }).expect(400);
    await tenant.castcoPerson.post(moves, { work_order_ids: ids, kind: 'pass', at_step: 'polishing', answers: surfaceOk }).expect(200);
    const photo = (await partnerPhoto(tenant.castcoPerson, tenant.castco)).versionId;
    await tenant.castcoPerson
      .post(moves, {
        work_order_ids: ids,
        kind: 'pass',
        at_step: 'final_qc',
        answers: [{ item: 'weight', value: '5.0' }],
        photo_file_version_ids: [photo],
      })
      .expect(200);
    expect((await pieces(tenant, tenant.accepted.group)).every((piece) => piece.step_key === 'packing')).toBe(true);

    // Packing is the workspace's: the partner can't pass it, nor correct a piece back from it.
    const refused = await tenant.castcoPerson.post(moves, { work_order_ids: ids, kind: 'pass', at_step: 'packing' }).expect(409);
    expect((refused.body as { errors: { path: string }[] }).errors[0].path).toBe('work_order_ids.0');
    await tenant.castcoPerson
      .post(moves, { work_order_ids: [ids[0]], kind: 'correction', to_step: 'polishing', comment: 'Back for a polish' })
      .expect(409);

    // Staff pass packing; that move counts for nobody.
    await tenant.staff.post('/workflow/moves', { work_order_ids: ids, kind: 'pass', at_step: 'packing' }).expect(200);
    const history = await tenant.staff.get(`/workflow/work-orders/${ids[0]}`).expect(200);
    expectDocumented(workOrderDetailResponseSchema, history.body);
    expect((history.body as { history: Transition[] }).history.map((move) => [move.from_step?.key, move.partner?.name ?? null])).toEqual([
      ['print_pattern', 'CastCo'],
      ['casting_tree', 'CastCo'],
      ['casting', 'CastCo'],
      ['polishing', 'CastCo'],
      ['final_qc', 'CastCo'],
      ['packing', null],
    ]);

    const finished = await tenant.castcoPerson.get(`${portal(tenant)}/jobs?status=finished`).expect(200);
    expect((finished.body as { data: PartnerJob[] }).data).toEqual([
      expect.objectContaining({ id: tenant.accepted.group, pieces: { active: 0, finished: 10, scrapped: 0 } }),
    ]);
  });

  it('passes a step that needs a photo with one the partner uploaded, which staff download from the transition', async () => {
    const tenant = await freshTenant();
    const moves = `${portal(tenant)}/moves`;
    const ids = (await pieces(tenant, tenant.accepted.group)).map((piece) => piece.id);
    await toFinalQc(tenant, ids);
    const finalQc = { work_order_ids: ids, kind: 'pass', at_step: 'final_qc', answers: [{ item: 'weight', value: '5.0' }] };

    // Final QC needs a photo (min_photos: 1).
    await tenant.castcoPerson.post(moves, finalQc).expect(400);
    const photo = await partnerPhoto(tenant.castcoPerson, tenant.castco);
    await tenant.castcoPerson.post(moves, { ...finalQc, photo_file_version_ids: [photo.versionId] }).expect(200);

    // Staff find the photo on the piece's transition, and download it.
    const detail = (await tenant.staff.get(`/workflow/work-orders/${ids[0]}`).expect(200)).body as { history: Transition[] };
    const atFinalQc = detail.history.find((move) => move.from_step?.key === 'final_qc')!;
    expect(atFinalQc.photos).toEqual([{ file_id: photo.fileId, file_version_id: photo.versionId }]);
    const link = await tenant.staff.get(`/files/${photo.fileId}/versions/${photo.versionId}/url`).expect(200);
    expectDocumented(downloadUrlResponseSchema, link.body);
    const listed = await tenant.staff.get(`/workflow/transitions?work_order_id=${ids[0]}`).expect(200);
    expectDocumented(pageSchema(transitionListItemSchema), listed.body);
  });

  it("refuses a photo the partner doesn't own on its move", async () => {
    const tenant = await freshTenant();
    const moves = `${portal(tenant)}/moves`;
    const ids = (await pieces(tenant, tenant.accepted.group)).map((piece) => piece.id);
    await toFinalQc(tenant, ids);
    const finalQc = { work_order_ids: ids, kind: 'pass', at_step: 'final_qc', answers: [{ item: 'weight', value: '5.0' }] };

    const staffFile = (await measuredDesign(prisma, tenant.id, tenant.ownerId, { status: 'uploaded', measures: [] })).versionId;
    const customerFile = (await measuredDesign(prisma, tenant.id, tenant.ownerId, { status: 'uploaded', measures: [], customerId: tenant.luna }))
      .versionId;
    const metalworksPhoto = (await partnerPhoto(tenant.metalworksPerson, tenant.metalworks)).versionId;
    for (const photo of [staffFile, customerFile, metalworksPhoto]) {
      const response = await tenant.castcoPerson.post(moves, { ...finalQc, photo_file_version_ids: [photo] });
      expect({ photo, status: response.status }).toEqual({ photo, status: 404 });
    }
    // Nothing moved.
    expect((await pieces(tenant, tenant.accepted.group)).every((piece) => piece.step_key === 'final_qc')).toBe(true);

    // Staff may still attach a workspace file at a partner's step.
    await tenant.staff.post('/workflow/moves', { ...finalQc, photo_file_version_ids: [staffFile] }).expect(200);
  });

  it('lets a suspended partner finish the job it holds, and nothing else', async () => {
    const tenant = await freshTenant();
    const castcoAdmin = await partnerPerson(tenant.id, tenant.castco, 'admin');
    const ids = (await pieces(tenant, tenant.accepted.group)).map((piece) => piece.id);
    await tenant.staff.post(`/partners/${tenant.castco}/suspend`).expect(200);

    // Its accepted job carries on, and the move still counts for it.
    const moved = await tenant.castcoPerson
      .post(`${portal(tenant)}/moves`, { work_order_ids: ids, kind: 'pass', at_step: 'print_pattern' })
      .expect(200);
    expectDocumented(moveResponseSchema, moved.body);
    const history = (await tenant.staff.get(`/workflow/work-orders/${ids[0]}`).expect(200)).body as { history: Transition[] };
    expect(history.history[0].partner).toEqual({ id: tenant.castco, name: 'CastCo' });
    // It can still upload the QC photos those moves need.
    await partnerPhoto(tenant.castcoPerson, tenant.castco);

    // No new job, and no change to its setup.
    await tenant.castcoPerson.post(`${portal(tenant)}/jobs/${tenant.offered.group}/accept`).expect(403);
    await castcoAdmin
      .put(`${portal(tenant)}/capabilities`, {
        capabilities: [{ step_type_id: tenant.cast.steps.casting, capacity: 10, capacity_period: 'week' }],
      })
      .expect(403);
    // It still reads.
    await tenant.castcoPerson.get(`${portal(tenant)}/jobs`).expect(200);
  });

  it("credits a staff move at a partner's step to the partner, and keeps other partners' pieces out of reach", async () => {
    const tenant = await freshTenant();
    const ids = (await pieces(tenant, tenant.accepted.group)).map((piece) => piece.id);

    // Staff moving at CastCo's step on CastCo's accepted job still counts for CastCo (B5).
    await tenant.staff.post('/workflow/moves', { work_order_ids: [ids[0]], kind: 'pass', at_step: 'print_pattern' }).expect(200);
    const history = (await tenant.staff.get(`/workflow/work-orders/${ids[0]}`).expect(200)).body as { history: Transition[] };
    expect(history.history[0].partner).toEqual({ id: tenant.castco, name: 'CastCo' });

    // MetalWorks can't move CastCo's pieces; CastCo can't move pieces of a job it hasn't accepted.
    await tenant.metalworksPerson
      .post(`/partner-portal/partners/${tenant.metalworks}/moves`, { work_order_ids: [ids[1]], kind: 'pass', at_step: 'print_pattern' })
      .expect(404);
    const offeredIds = (
      (await tenant.staff.get(`/workflow/work-orders?group_id=${tenant.offered.group}`).expect(200)).body as { data: { id: string }[] }
    ).data.map((piece) => piece.id);
    await tenant.castcoPerson
      .post(`${portal(tenant)}/moves`, { work_order_ids: [offeredIds[0]], kind: 'pass', at_step: 'print_pattern' })
      .expect(404);
    // Nor a mix of its own and another job's pieces.
    await tenant.castcoPerson
      .post(`${portal(tenant)}/moves`, { work_order_ids: [ids[1], offeredIds[0]], kind: 'pass', at_step: 'print_pattern' })
      .expect(404);

    // A piece staff moved with no partner on the job counts for nobody.
    await tenant.staff.post('/workflow/moves', { work_order_ids: [offeredIds[0]], kind: 'pass', at_step: 'print_pattern' }).expect(200);
    const unassigned = (await tenant.staff.get(`/workflow/work-orders/${offeredIds[0]}`).expect(200)).body as { history: Transition[] };
    expect(unassigned.history[0].partner).toBeNull();
  });
});
