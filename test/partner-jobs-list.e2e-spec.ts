import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { partnerJobCountsResponseSchema, partnerJobsResponseSchema } from '../src/modules/partners/partner-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface VersionStep {
  key: string;
  name: string;
  step_type: { id: string };
  checklist: object[];
  defects: { defect_id: string; outcome: string; rework_to?: string | null }[];
  rework_targets: string[];
  pass: object;
  fail: object;
  customer: object;
}
interface Page {
  data: { id: string; status: string; due_on: string | null }[];
  next_cursor: string | null;
}

const sorted = (list: string[]) => [...list].sort((a, b) => a.localeCompare(b));

/** Today in the workspace (UTC, as test workspaces are), `days` on. */
const fromToday = (days: number) => new Date(Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The partner's jobs list as the Jobs page reads it (partner jobs list spec, 2026-11-21): counts per tab
 * and tile, search, the due filter and the sorts, all decided before paging. Late and due soon are only
 * jobs the partner is working on.
 */
describe('partners: counting, searching, filtering and sorting their jobs', () => {
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
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });
  type Person = ReturnType<typeof as>;

  let tenantId: string;
  let castco: string;
  let castcoPerson: Person;
  let metalworksPerson: Person;
  /** The jobs, in the order they were offered. */
  let j: Record<'late' | 'today' | 'plus2' | 'plus3' | 'undated' | 'offeredLate' | 'finished', string>;

  const portal = () => `/partner-portal/partners/${castco}/jobs`;
  const list = async (query: string): Promise<Page> => {
    const response = await castcoPerson.get(`${portal()}?${query}`).expect(200);
    expectDocumented(partnerJobsResponseSchema, response.body);
    return response.body as Page;
  };
  const ids = async (query: string) => (await list(`limit=200&${query}`)).data.map((job) => job.id);
  const counts = async (query = '') => {
    const response = await castcoPerson.get(`${portal()}/counts?${query}`).expect(200);
    expectDocumented(partnerJobCountsResponseSchema, response.body);
    return response.body as Record<'offered' | 'accepted' | 'finished' | 'late' | 'due_soon', number>;
  };

  async function partnerPerson(partnerId: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind: 'partner' } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'partner', organisationId: partnerId, role: 'member' } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
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

    const tenant = await createTestTenant(prisma);
    tenantId = tenant.id;
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    // Every day a working day: the due-soon window is today to two days on, whatever weekday this runs.
    await staff.put('/settings/business.calendar', { workingDays: [1, 2, 3, 4, 5, 6, 7], startHour: 8, endHour: 24, closedDates: [] }).expect(200);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const { printPattern, castingTree, casting, polishing } = cast.steps;

    // Final QC and packing done in-house, so a job is the partner's to finish at polishing.
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
          done_by: step.key === 'packing' || step.key === 'final_qc' ? 'workspace' : 'partner',
        })),
      })
      .expect(200);

    const partner = async (name: string) => {
      const id = ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
      await staff
        .put(`/partners/${id}/capabilities`, {
          capabilities: [printPattern, castingTree, casting, polishing].map((step_type_id) => ({ step_type_id, capacity: 200, capacity_period: 'week' })),
        })
        .expect(200);
      await staff.put(`/partners/${id}/offerings`, { option_value_ids: [cast.v.silver, cast.v.brass, cast.v.raw, cast.v.polished] }).expect(200);
      await staff.post(`/partners/${id}/prices/copy-from-workspace`).expect(200);
      const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return id;
    };
    castco = await partner('CastCo');
    castcoPerson = await partnerPerson(castco);
    metalworksPerson = await partnerPerson(await partner('MetalWorks'));

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const design = await measuredDesign(prisma, tenant.id, owner.id, { customerId: luna });
    const job = async (material: string, finish: string, dueIn: number | null, held: 'offered' | 'accepted' | 'finished') => {
      const quoted = await staff
        .post('/pricing/quotes', { product_id: cast.productId, options: { material, finish }, size: { scale: '1.5' }, file_version_id: design.versionId, quantity: 1, customer_id: luna })
        .expect(201);
      const group = ((await staff.post('/workflow/groups', { quote_id: (quoted.body as { quote: { id: string } }).quote.id }).expect(201)).body as { id: string }).id;
      await staff.post(`/partners/jobs/${group}/offer`, { partner_id: castco }).expect(201);
      if (held !== 'offered') await castcoPerson.post(`${portal()}/${group}/accept`).expect(200);
      await prisma.inTenant(tenant.id, (tx) =>
        tx.jobAssignment.updateMany({ where: { groupId: group }, data: { dueOn: dueIn === null ? null : new Date(`${fromToday(dueIn)}T00:00:00Z`) } }),
      );
      if (held === 'finished') {
        const pieces = ((await castcoPerson.get(`${portal()}/${group}`).expect(200)).body as { work_orders: { id: string }[] }).work_orders.map((piece) => piece.id);
        const moves = `/partner-portal/partners/${castco}/moves`;
        for (const at_step of ['print_pattern', 'casting_tree', 'casting']) {
          await castcoPerson.post(moves, { work_order_ids: pieces, kind: 'pass', at_step }).expect(200);
        }
        await castcoPerson.post(moves, { work_order_ids: pieces, kind: 'pass', at_step: 'polishing', answers: [{ item: 'surface', value: 'ok' }] }).expect(200);
      }
      return group;
    };
    j = {
      late: await job('brass', 'raw', -1, 'accepted'),
      today: await job('silver_925', 'polished', 0, 'accepted'),
      plus2: await job('silver_925', 'polished', 2, 'accepted'),
      plus3: await job('silver_925', 'raw', 3, 'accepted'),
      undated: await job('silver_925', 'polished', null, 'accepted'),
      offeredLate: await job('silver_925', 'polished', -1, 'offered'),
      finished: await job('silver_925', 'polished', -1, 'finished'),
    };
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('lists late and due-soon jobs among those in progress only', async () => {
    expect((await list('limit=200')).data.find((job) => job.id === j.finished)?.status).toBe('finished');
    expect(await ids('due=late')).toEqual([j.late]);
    expect(sorted(await ids('due=due_soon'))).toEqual(sorted([j.today, j.plus2]));
    expect(sorted(await ids('due=late,due_soon'))).toEqual(sorted([j.late, j.today, j.plus2]));
    // ANDed with the tab: an offer is never late.
    expect(await ids('status=offered&due=late')).toEqual([]);
    expect(sorted(await ids('status=accepted&due=late,due_soon'))).toEqual(sorted([j.late, j.today, j.plus2]));
    await castcoPerson.get(`${portal()}?due=soon`).expect(400);
  });

  it('searches the product name and the chosen option values, case-insensitive', async () => {
    expect((await ids('q=CUSTOM%20cast')).length).toBe(7);
    expect(await ids('q=BRASS')).toEqual([j.late]);
    expect(sorted(await ids('q=raw'))).toEqual(sorted([j.late, j.plus3]));
    // A wildcard is a character like any other: `_` is in `silver_925`, and `r_w` is not `raw`.
    expect(await ids('q=%25')).toEqual([]);
    expect(await ids('q=r_w')).toEqual([]);
    expect(await ids('q=%5C')).toEqual([]);
    expect(sorted(await ids('q=r_9'))).toEqual(sorted([j.today, j.plus2, j.plus3, j.undated, j.offeredLate, j.finished]));
    expect(await ids('q=nothing-like-this')).toEqual([]);
    expect((await ids('q=raw&due=late'))).toEqual([j.late]);
    await castcoPerson.get(`${portal()}?q=`).expect(400);
  });

  it('sorts by hand-over and by due date, undated jobs last both ways', async () => {
    const offered = [j.late, j.today, j.plus2, j.plus3, j.undated, j.offeredLate, j.finished];
    expect(await ids('')).toEqual([...offered].reverse());
    expect(await ids('sort=-offered_at')).toEqual([...offered].reverse());
    expect(await ids('sort=offered_at')).toEqual(offered);
    // Ties on a day break by id in the sort's direction.
    expect(await ids('sort=due_on')).toEqual([j.late, j.offeredLate, j.finished, j.today, j.plus2, j.plus3, j.undated]);
    expect(await ids('sort=-due_on')).toEqual([j.plus3, j.plus2, j.today, j.finished, j.offeredLate, j.late, j.undated]);
    await castcoPerson.get(`${portal()}?sort=due`).expect(400);
  });

  it('pages each sort one job at a time without skipping or repeating', async () => {
    for (const sort of ['-offered_at', 'offered_at', 'due_on', '-due_on']) {
      const walked: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Page = await list(`sort=${sort}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        walked.push(...page.data.map((job) => job.id));
        cursor = page.next_cursor;
      } while (cursor);
      expect([sort, walked]).toEqual([sort, await ids(`sort=${sort}`)]);
    }
    // A cursor goes with the sort it was made for.
    const byDue = await list('sort=due_on&limit=1');
    await castcoPerson.get(`${portal()}?sort=-due_on&cursor=${encodeURIComponent(byDue.next_cursor!)}`).expect(400);
    await castcoPerson.get(`${portal()}?cursor=${encodeURIComponent(byDue.next_cursor!)}`).expect(400);
    const byOffer = await list('limit=1');
    await castcoPerson.get(`${portal()}?sort=due_on&cursor=${encodeURIComponent(byOffer.next_cursor!)}`).expect(400);
  });

  it('counts each tab and tile as the list filters them, with and without a search', async () => {
    expect(await counts()).toEqual({ offered: 1, accepted: 5, finished: 1, late: 1, due_soon: 2 });
    expect(await counts('q=raw')).toEqual({ offered: 0, accepted: 2, finished: 0, late: 1, due_soon: 0 });
    for (const q of ['', 'q=raw', 'q=polished']) {
      const shown = await counts(q);
      for (const status of ['offered', 'accepted', 'finished'] as const) {
        expect([q, status, shown[status]]).toEqual([q, status, (await ids(`status=${status}&${q}`)).length]);
      }
      for (const due of ['late', 'due_soon'] as const) {
        expect([q, due, shown[due]]).toEqual([q, due, (await ids(`due=${due}&${q}`)).length]);
      }
    }
  });

  it('takes only a search on the counts, and only for the partner itself', async () => {
    for (const query of ['status=offered', 'due=late', 'sort=due_on', 'cursor=abc', 'limit=10', 'color=red']) {
      await castcoPerson.get(`${portal()}/counts?${query}`).expect(400);
    }
    await metalworksPerson.get(`${portal()}/counts`).expect(404);
  });

  // Last: it moves an offer's deadline into the past.
  it('leaves out an offer past its deadline before the expiry run', async () => {
    await prisma.inTenant(tenantId, (tx) => tx.jobAssignment.updateMany({ where: { groupId: j.offeredLate }, data: { expiresAt: new Date(Date.now() - 60_000) } }));
    expect((await counts()).offered).toBe(0);
    expect(await ids('status=offered')).toEqual([]);
  });
});
