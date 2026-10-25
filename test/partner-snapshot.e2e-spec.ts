import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { CapacitySnapshotHandler } from '../src/modules/partners/capacity-snapshot.handler';
import { capacityHistoryResponseSchema } from '../src/modules/partners/partner-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Row {
  date: string;
  step_type: { id: string; key: string; name: string };
  load: number;
  capacity: number;
  capacity_period: string;
}

/**
 * Capacity history (Partners spec, D83): once a day, each partner's load and capacity per step type is
 * kept, the one stored counter; running it again the same day replaces that day's rows.
 */
describe('partners: capacity history', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let snapshot: CapacitySnapshotHandler;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none, so silver is at its fallback.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });
  const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  /** The priced cast part; CastCo approved for the whole line, with casting at 40 a day; a job of 10 rings it accepted. */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;

    const castco = ((await staff.post('/partners', { name: 'CastCo', display_name: 'CastCo' }).expect(201)).body as { id: string }).id;
    await staff
      .put(`/partners/${castco}/capabilities`, {
        capabilities: [printPattern, castingTree, casting, polishing, finalQc, packing].map((step_type_id) => ({
          step_type_id,
          capacity: step_type_id === casting ? 40 : 200,
          capacity_period: step_type_id === casting ? 'day' : 'week',
        })),
      })
      .expect(200);
    await staff.put(`/partners/${castco}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
    await staff.post(`/partners/${castco}/prices/copy-from-workspace`).expect(200);
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
    await staff.put(`/partners/${castco}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
    await staff.post(`/partners/${castco}/approve`).expect(200);
    // A partner still being set up, with one capability and nothing to do.
    const newcomer = ((await staff.post('/partners', { name: 'Newcomer', display_name: 'Newcomer' }).expect(201)).body as { id: string }).id;
    await staff
      .put(`/partners/${newcomer}/capabilities`, { capabilities: [{ step_type_id: printPattern, capacity: 50, capacity_period: 'week' }] })
      .expect(200);

    const quoted = await staff
      .post('/pricing/quotes', {
        product_id: cast.productId,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        file_version_id: cast.versionId,
        quantity: 10,
      })
      .expect(201);
    const quoteId = (quoted.body as { quote: { id: string } }).quote.id;
    const group = ((await staff.post('/workflow/groups', { quote_id: quoteId }).expect(201)).body as { id: string }).id;
    await staff.post(`/partners/jobs/${group}/offer`, { partner_id: castco }).expect(201);

    const person = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.user.update({ where: { id: person.id }, data: { kind: 'partner' } });
      await tx.organisationMembership.create({ data: { userId: person.id, organisationType: 'partner', organisationId: castco, role: 'owner' } });
    });
    const castcoPerson = as((await tokens.issueForUser(tenant.id, person.id)).accessToken);
    await castcoPerson.post(`/partner-portal/partners/${castco}/jobs/${group}/accept`).expect(200);

    return {
      id: tenant.id,
      staff,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      castco,
      newcomer,
      group,
      castcoPerson,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const history = async (tenant: Tenant, partnerId: string, query = '') => {
    const response = await tenant.staff.get(`/partners/${partnerId}/capacity-history${query}`).expect(200);
    expectDocumented(capacityHistoryResponseSchema, response.body);
    return (response.body as { data: Row[] }).data;
  };
  const stored = (tenant: Tenant) => prisma.inTenant(tenant.id, (tx) => tx.partnerCapacitySnapshot.count());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    snapshot = moduleRef.get(CapacitySnapshotHandler);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it("keeps each partner's load and capacity per step type once a day, replacing the day's rows when run again", async () => {
    const tenant = await freshTenant();
    expect(await history(tenant, tenant.castco)).toEqual([]);

    await snapshot.handle();
    const first = await history(tenant, tenant.castco);
    // In step type order: the 10 rings are still ahead of every step.
    expect(first.map((row) => [row.date, row.step_type.key, row.load, row.capacity, row.capacity_period])).toEqual([
      [day(), 'print_pattern', 10, 200, 'week'],
      [day(), 'casting_tree', 10, 200, 'week'],
      [day(), 'casting', 10, 40, 'day'],
      [day(), 'polishing', 10, 200, 'week'],
      [day(), 'final_qc', 10, 200, 'week'],
      [day(), 'packing', 10, 200, 'week'],
    ]);
    // A partner still being set up is kept too, with nothing to do.
    expect((await history(tenant, tenant.newcomer)).map((row) => [row.step_type.key, row.load, row.capacity])).toEqual([
      ['print_pattern', 0, 50],
    ]);
    expect(await stored(tenant)).toBe(7);

    // The rings pass print pattern; the run again today replaces today's rows.
    const ids = ((await tenant.staff.get(`/workflow/work-orders?group_id=${tenant.group}`).expect(200)).body as { data: { id: string }[] }).data.map(
      (piece) => piece.id,
    );
    await tenant.castcoPerson
      .post(`/partner-portal/partners/${tenant.castco}/moves`, { work_order_ids: ids, kind: 'pass', at_step: 'print_pattern' })
      .expect(200);
    await snapshot.handle();
    const second = await history(tenant, tenant.castco);
    expect(second.map((row) => [row.step_type.key, row.load])).toEqual([
      ['print_pattern', 0],
      ['casting_tree', 10],
      ['casting', 10],
      ['polishing', 10],
      ['final_qc', 10],
      ['packing', 10],
    ]);
    expect(await stored(tenant)).toBe(7);

    // A range: today alone, or yesterday, which has nothing.
    expect(await history(tenant, tenant.castco, `?from=${day()}&to=${day()}`)).toHaveLength(6);
    expect(await history(tenant, tenant.castco, `?from=${day(-1)}&to=${day(-1)}`)).toEqual([]);
  });

  it('refuses a bad range, and keeps the history to staff of the workspace', async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const path = `/partners/${tenant.castco}/capacity-history`;

    await tenant.staff.get(`${path}?from=2026-13-01`).expect(400);
    await tenant.staff.get(`${path}?from=${day()}&to=${day(-1)}`).expect(400);
    await tenant.staff.get(`${path}?from=2025-01-01&to=2026-06-01`).expect(400);
    await tenant.staff.get('/partners/not-an-id/capacity-history').expect(400);
    await other.staff.get(path).expect(404);
    await tenant.castcoPerson.get(path).expect(403);
    // Staff members may read partners.
    await tenant.member.get(path).expect(200);
  });
});
