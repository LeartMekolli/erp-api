import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { partnerResponseSchema, partnerSetupResponseSchema } from '../src/modules/partners/partner-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Setup {
  partner_id: string;
  max_open_jobs: number | null;
  accepts_direct_orders: boolean;
  capabilities: {
    step_type: { id: string; key: string };
    min_quantity: number;
    max_quantity: number | null;
    max_size_mm: string | null;
    capacity: number;
    capacity_period: string;
  }[];
  closed_periods: { starts_on: string; ends_on: string; note: string | null }[];
  offerings: { option_value_id: string; group_key: string; key: string }[];
}

/**
 * What a partner can do, how much, when it is closed and which option values it offers (Partners
 * spec, goals 4–6 and 17), set by the partner's own people or by staff on its behalf.
 */
describe('partners: capabilities, capacity, closed periods and offerings', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const id = (response: request.Response) => (response.body as { id: string }).id;
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  /** A partner person written straight to the database, with a membership in `partnerId`. */
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

  /** Two partners, CastCo with an owner and a member, the step types of a cast line and two option groups. */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const partner = async (name: string) => id(await staff.post('/partners', { name, display_name: name }).expect(201));
    const castco = await partner('CastCo');
    const metalworks = await partner('MetalWorks');

    const stepType = async (key: string, position: number, summary_group: string | null) =>
      id(await staff.post('/pricing/step-types', { key, name: key, position, summary_group }).expect(201));
    const types = {
      printPattern: await stepType('print_pattern', 10, 'making'),
      castingTree: await stepType('casting_tree', 20, 'making'),
      casting: await stepType('casting', 30, 'making'),
      polishing: await stepType('polishing', 40, 'finishing'),
      // Nobody prices final QC, but it is still a partner's step on the cast workflow.
      finalQc: await stepType('final_qc', 90, null),
    };

    const silver = id(
      await staff
        .post('/catalog/materials', { key: 'silver_925', name: 'Silver', priced_unit: 'g', price_source: 'manual', manual_price: '1' })
        .expect(201),
    );
    const group = async (key: string) => id(await staff.post('/catalog/option-groups', { key, name: key }).expect(201));
    const value = async (groupId: string, key: string, material_id?: string) =>
      id(await staff.post(`/catalog/option-groups/${groupId}/values`, { key, name: key, material_id }).expect(201));
    const material = await group('material');
    const finish = await group('finish');
    const values = {
      silver: await value(material, 'silver_925', silver),
      gold: await value(material, 'gold'),
      polished: await value(finish, 'polished'),
    };

    return {
      id: tenant.id,
      ownerId: owner.id,
      staff,
      castco,
      metalworks,
      types,
      values,
      castcoOwner: await partnerPerson(tenant.id, castco, 'owner'),
      castcoAdmin: await partnerPerson(tenant.id, castco, 'admin'),
      castcoMember: await partnerPerson(tenant.id, castco, 'member'),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** CastCo's cast line at 200 pieces a week; casting takes pieces up to 40 mm. */
  const castLine = (tenant: Tenant) => ({
    capabilities: [
      { step_type_id: tenant.types.printPattern, capacity: 200, capacity_period: 'week' },
      { step_type_id: tenant.types.castingTree, capacity: 200, capacity_period: 'week' },
      { step_type_id: tenant.types.casting, capacity: 200, capacity_period: 'week', max_size_mm: '40', max_quantity: 500 },
      { step_type_id: tenant.types.polishing, capacity: 200, capacity_period: 'week' },
      { step_type_id: tenant.types.finalQc, capacity: 40, capacity_period: 'day' },
    ],
  });

  beforeAll(async () => {
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

  it("lets the partner's owner and admins set up what it can do, how much, when and with which options", async () => {
    const tenant = await freshTenant();
    const portal = `/partner-portal/partners/${tenant.castco}`;

    const empty = await tenant.castcoMember.get(`${portal}/setup`).expect(200);
    expectDocumented(partnerSetupResponseSchema, empty.body);
    expect(empty.body).toEqual({
      partner_id: tenant.castco,
      max_open_jobs: null,
      accepts_direct_orders: false,
      capabilities: [],
      closed_periods: [],
      offerings: [],
    });

    const capabilities = await tenant.castcoOwner.put(`${portal}/capabilities`, castLine(tenant)).expect(200);
    expectDocumented(partnerSetupResponseSchema, capabilities.body);
    const casting = (capabilities.body as Setup).capabilities.find((one) => one.step_type.key === 'casting');
    expect(casting).toEqual({
      step_type: { id: tenant.types.casting, key: 'casting', name: 'casting' },
      min_quantity: 1,
      max_quantity: 500,
      max_size_mm: '40',
      capacity: 200,
      capacity_period: 'week',
    });
    expect((capabilities.body as Setup).capabilities.map((one) => one.step_type.key)).toEqual([
      'print_pattern',
      'casting_tree',
      'casting',
      'polishing',
      'final_qc',
    ]);

    const closed = await tenant.castcoAdmin
      .put(`${portal}/closed-periods`, { closed_periods: [{ starts_on: '2026-12-24', ends_on: '2026-12-31', note: 'Holidays' }] })
      .expect(200);
    expectDocumented(partnerSetupResponseSchema, closed.body);
    expect((closed.body as Setup).closed_periods).toEqual([{ starts_on: '2026-12-24', ends_on: '2026-12-31', note: 'Holidays' }]);

    const offered = await tenant.castcoAdmin
      .put(`${portal}/offerings`, { option_value_ids: [tenant.values.silver, tenant.values.polished] })
      .expect(200);
    expectDocumented(partnerSetupResponseSchema, offered.body);
    expect((offered.body as Setup).offerings.map((one) => [one.group_key, one.key]).sort()).toEqual([
      ['finish', 'polished'],
      ['material', 'silver_925'],
    ]);

    const limits = await tenant.castcoOwner.patch(`${portal}/limits`, { max_open_jobs: 3, accepts_direct_orders: true }).expect(200);
    expectDocumented(partnerSetupResponseSchema, limits.body);
    expect(limits.body).toMatchObject({ max_open_jobs: 3, accepts_direct_orders: true });

    // Staff read the same setup, and the partner itself now accepts direct orders.
    const read = await tenant.staff.get(`/partners/${tenant.castco}/setup`).expect(200);
    expect(read.body).toEqual(limits.body);
    expect((await tenant.staff.get(`/partners/${tenant.castco}`).expect(200)).body).toMatchObject({ accepts_direct_orders: true });

    // Members work jobs; they don't change the setup.
    await tenant.castcoMember.put(`${portal}/capabilities`, castLine(tenant)).expect(403);
    await tenant.castcoMember.put(`${portal}/offerings`, { option_value_ids: [] }).expect(403);
    await tenant.castcoMember.patch(`${portal}/limits`, { max_open_jobs: 1 }).expect(403);

    // Each set is replaced whole: an empty list empties it.
    const cleared = await tenant.castcoOwner.put(`${portal}/capabilities`, { capabilities: [] }).expect(200);
    expect(cleared.body).toMatchObject({ capabilities: [], offerings: [expect.anything(), expect.anything()] });
  });

  it('lets staff set up a partner on its behalf, and refuses what does not fit', async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const path = `/partners/${tenant.metalworks}`;

    const set = await tenant.staff.put(`${path}/capabilities`, castLine(tenant)).expect(200);
    expectDocumented(partnerSetupResponseSchema, set.body);
    expect((set.body as Setup).capabilities).toHaveLength(5);
    await tenant.staff.put(`${path}/closed-periods`, { closed_periods: [{ starts_on: '2026-12-24', ends_on: '2026-12-24' }] }).expect(200);
    await tenant.staff.put(`${path}/offerings`, { option_value_ids: [tenant.values.gold] }).expect(200);
    await tenant.staff.patch(`${path}/limits`, { max_open_jobs: null }).expect(200);

    const capability = castLine(tenant).capabilities[2];
    for (const capabilities of [
      // Unknown and another workspace's step type.
      [{ ...capability, step_type_id: newId() }],
      [{ ...capability, step_type_id: other.types.casting }],
    ]) {
      await tenant.staff.put(`${path}/capabilities`, { capabilities }).expect(404);
    }
    for (const capabilities of [
      [{ ...capability, min_quantity: 10, max_quantity: 5 }],
      [{ ...capability, capacity: 0 }],
      [{ ...capability, capacity_period: 'month' }],
      [{ ...capability, max_size_mm: '-1' }],
      [capability, capability],
    ]) {
      await tenant.staff.put(`${path}/capabilities`, { capabilities }).expect(400);
    }

    await tenant.staff.put(`${path}/offerings`, { option_value_ids: [newId()] }).expect(404);
    await tenant.staff.put(`${path}/offerings`, { option_value_ids: [other.values.silver] }).expect(404);
    await tenant.staff.put(`${path}/offerings`, { option_value_ids: [tenant.values.gold, tenant.values.gold] }).expect(400);
    await tenant.staff
      .put(`${path}/closed-periods`, { closed_periods: [{ starts_on: '2026-12-31', ends_on: '2026-12-24' }] })
      .expect(400);
    await tenant.staff.put(`${path}/closed-periods`, { closed_periods: [{ starts_on: '24/12/2026', ends_on: '2026-12-31' }] }).expect(400);
    await tenant.staff.patch(`${path}/limits`, { max_open_jobs: 0 }).expect(400);

    // Nothing refused was kept.
    const read = (await tenant.staff.get(`${path}/setup`).expect(200)).body as Setup;
    expect(read.capabilities).toHaveLength(5);
    expect(read.offerings.map((one) => one.option_value_id)).toEqual([tenant.values.gold]);
    expect(read.closed_periods).toEqual([{ starts_on: '2026-12-24', ends_on: '2026-12-24', note: null }]);

    // Another workspace's partner, or another partner's portal.
    await tenant.staff.get(`/partners/${other.castco}/setup`).expect(404);
    await tenant.staff.put(`/partners/${other.castco}/capabilities`, castLine(tenant)).expect(404);
    await tenant.castcoOwner.put(`/partner-portal/partners/${tenant.metalworks}/capabilities`, castLine(tenant)).expect(404);
  });

  it('tells staff once when the partner is ready for approval', async () => {
    const tenant = await freshTenant();
    const portal = `/partner-portal/partners/${tenant.castco}`;
    const submitted = () =>
      prisma.inTenant(tenant.id, (tx) =>
        tx.notification.count({ where: { eventKey: 'partner.submitted', subjectType: 'partner', subjectId: tenant.castco } }),
      );

    // Only the owner says the setup is done.
    await tenant.castcoAdmin.post(`${portal}/submit`).expect(403);

    const first = await tenant.castcoOwner.post(`${portal}/submit`).expect(200);
    expectDocumented(partnerResponseSchema, first.body);
    expect(first.body).toMatchObject({ status: 'setting_up', submitted_at: expect.any(String) });
    expect(await submitted()).toBe(1);

    // Again while still being set up: no second notification.
    const again = await tenant.castcoOwner.post(`${portal}/submit`).expect(200);
    expect((again.body as { submitted_at: string }).submitted_at).toBe((first.body as { submitted_at: string }).submitted_at);
    expect(await submitted()).toBe(1);

    // An approved partner has nothing to submit.
    const agreement = (await measuredDesign(prisma, tenant.id, tenant.ownerId, { status: 'uploaded', measures: [] })).versionId;
    await tenant.staff
      .put(`/partners/${tenant.castco}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' })
      .expect(200);
    await tenant.staff.post(`/partners/${tenant.castco}/approve`).expect(200);
    await tenant.castcoOwner.post(`${portal}/submit`).expect(409);
    expect(await submitted()).toBe(1);
  });
});
