import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { partnerChoicesResponseSchema } from '../src/modules/partners/partner-response';
import { quoteResponseSchema } from '../src/modules/pricing/quote-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Choice {
  partner: { id: string; display_name: string };
  score: number | null;
  price: { currency: string; unit_price: string; total: string };
}
interface Summary {
  id: string;
  unit_price: string;
  total: string;
}

/**
 * Customers who may pick a workshop (Partners spec, goals 11 and 12; B2; plan Review Focus 5): only
 * partners that take direct orders and can take the job, each at its own price; the job is the
 * partner's at once when it starts, unless the partner can no longer take it.
 */
describe('partners: customers picking a workshop, and direct jobs', () => {
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

  /** A person written straight to the database, of `kind`, with a membership in an organisation. */
  async function person(tenantId: string, kind: 'customer' | 'partner', organisationId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: kind, organisationId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /**
   * The priced cast part, published; CastCo (no direct orders) and MetalWorks (direct orders, casting setup 50
   * against the workspace's 15), both approved for the whole cast line; Luna Jewels with a buyer.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    // Customers only see published products.
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;

    const partner = async (name: string, castingSetup: string, direct: boolean) => {
      const id = ((await staff.post('/partners', { name: `${name} Ltd`, display_name: name }).expect(201)).body as { id: string }).id;
      await staff
        .put(`/partners/${id}/capabilities`, {
          capabilities: [printPattern, castingTree, casting, polishing, finalQc, packing].map((step_type_id) => ({
            step_type_id,
            capacity: 200,
            capacity_period: 'week',
          })),
        })
        .expect(200);
      await staff.put(`/partners/${id}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
      await staff.post(`/partners/${id}/prices/copy-from-workspace`).expect(200);
      await staff
        .put(`/partners/${id}/step-types/${casting}/prices`, {
          failure_percent: '0',
          blocks: [
            { kind: 'material', source: { configuration: true }, basis: 'weight', loss_percent: '5' },
            { kind: 'setup', amount: castingSetup },
          ],
        })
        .expect(200);
      await staff.patch(`/partners/${id}/limits`, { accepts_direct_orders: direct }).expect(200);
      const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return id;
    };
    const castco = await partner('CastCo', '30', false);
    const metalworks = await partner('MetalWorks', '50', true);

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    // Luna's own design: a customer may only quote with its own files.
    const design = (await measuredDesign(prisma, tenant.id, owner.id, { customerId: luna })).versionId;

    return {
      id: tenant.id,
      staff,
      cast,
      castco,
      metalworks,
      luna,
      buyer: await person(tenant.id, 'customer', luna, 'buyer'),
      viewer: await person(tenant.id, 'customer', luna, 'viewer'),
      metalworksPerson: await person(tenant.id, 'partner', metalworks, 'member'),
      body: (extra: object = {}) => ({
        product_id: cast.productId,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        file_version_id: design,
        quantity: 10,
        ...extra,
      }),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const quotes = (tenant: Tenant) => `/portal/customers/${tenant.luna}/quotes`;
  const pickable = (tenant: Tenant) => tenant.staff.patch(`/customers/${tenant.luna}`, { may_pick_partner: true }).expect(200);
  const counts = (tenant: Tenant) =>
    prisma.inTenant(tenant.id, async (tx) => ({ groups: await tx.workOrderGroup.count(), pieces: await tx.workOrder.count() }));

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

  it('lists the workshops a customer may pick, each at its own price, and never what they cost', async () => {
    const tenant = await freshTenant();

    // Only once the workspace lets Luna pick, and only for people who may order.
    await tenant.buyer.post(`${quotes(tenant)}/partners`, tenant.body()).expect(403);
    const switched = await pickable(tenant);
    expect(switched.body).toMatchObject({ may_pick_partner: true });
    await tenant.viewer.post(`${quotes(tenant)}/partners`, tenant.body()).expect(403);

    const listed = await tenant.buyer.post(`${quotes(tenant)}/partners`, tenant.body()).expect(200);
    expectDocumented(partnerChoicesResponseSchema, listed.body);
    const choices = (listed.body as { data: Choice[] }).data;
    // CastCo doesn't take direct orders, so it is never offered to customers.
    expect(choices.map((choice) => choice.partner)).toEqual([{ id: tenant.metalworks, display_name: 'MetalWorks' }]);
    for (const secret of ['"cost"', 'MetalWorks Ltd', 'margin', 'reasons']) {
      expect({ secret, found: listed.text.includes(secret) }).toEqual({ secret, found: false });
    }

    // MetalWorks' casting setup is 35 more for the run of 10: 3.50 a piece, plus the 40 % margin, less
    // the 5 % quantity discount, is 4.655 a piece more than the workspace's own price.
    const own = ((await tenant.buyer.post(quotes(tenant), tenant.body()).expect(201)).body as { quote: Summary }).quote;
    const difference = new Prisma.Decimal(choices[0].price.unit_price).minus(own.unit_price);
    expect(difference.minus('4.655').abs().lessThanOrEqualTo('0.01')).toBe(true);
  });

  it("quotes at the picked workshop's price, and the job is the workshop's as soon as it starts", async () => {
    const tenant = await freshTenant();
    await pickable(tenant);
    const choice = ((await tenant.buyer.post(`${quotes(tenant)}/partners`, tenant.body()).expect(200)).body as { data: Choice[] }).data[0];

    const quoted = await tenant.buyer.post(quotes(tenant), tenant.body({ partner_id: tenant.metalworks })).expect(201);
    const quote = (quoted.body as { quote: Summary }).quote;
    expect(quote).toMatchObject({ unit_price: choice.price.unit_price, total: choice.price.total });
    expect(quoted.text).not.toContain('"cost"');

    // Staff see whose price it is, and what the workshop is paid.
    const staffView = await tenant.staff.get(`/pricing/quotes/${quote.id}`).expect(200);
    expectDocumented(quoteResponseSchema, staffView.body);
    const picked = (staffView.body as { partner: { id: string; cost: string } }).partner;
    expect(picked.id).toBe(tenant.metalworks);

    const started = await tenant.staff.post('/workflow/groups', { quote_id: quote.id }).expect(201);
    const group = (started.body as { id: string }).id;
    const history = (await tenant.staff.get(`/partners/jobs/${group}`).expect(200)).body as {
      data: { partner: { id: string }; kind: string; status: string; cost: string }[];
    };
    expect(history.data).toEqual([
      expect.objectContaining({ partner: expect.objectContaining({ id: tenant.metalworks }), kind: 'direct', status: 'accepted', cost: picked.cost }),
    ]);
    expect(await prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey: 'partner.job.direct' } }))).toBe(1);

    const theirs = await tenant.metalworksPerson.get(`/partner-portal/partners/${tenant.metalworks}/jobs`).expect(200);
    expect((theirs.body as { data: { id: string; status: string }[] }).data).toEqual([
      expect.objectContaining({ id: group, status: 'accepted' }),
    ]);
    // A direct job is never offered: there is nothing more to offer or answer.
    await tenant.staff.post(`/partners/jobs/${group}/offer`, { partner_id: tenant.castco }).expect(409);
  });

  it('keeps a started direct job when telling the workshop fails', async () => {
    const tenant = await freshTenant();
    await pickable(tenant);
    const quoted = await tenant.buyer.post(quotes(tenant), tenant.body({ partner_id: tenant.metalworks })).expect(201);
    const quote = (quoted.body as { quote: Summary }).quote;

    // The start has committed by the time the workshop is told; a failure there doesn't undo or hide it.
    const raise = jest.spyOn(app.get(NotificationsService), 'raise').mockRejectedValueOnce(new Error('down'));
    try {
      const started = await tenant.staff.post('/workflow/groups', { quote_id: quote.id }).expect(201);
      const group = (started.body as { id: string }).id;
      const history = (await tenant.staff.get(`/partners/jobs/${group}`).expect(200)).body as { data: { kind: string; status: string }[] };
      expect(history.data).toEqual([expect.objectContaining({ kind: 'direct', status: 'accepted' })]);
    } finally {
      raise.mockRestore();
    }
  });

  it('asks the customer to pick again when the workshop can no longer take the job', async () => {
    const tenant = await freshTenant();
    await pickable(tenant);

    // CastCo doesn't take direct orders: a customer can't name it.
    const refused = await tenant.buyer.post(quotes(tenant), tenant.body({ partner_id: tenant.castco })).expect(200);
    expect(refused.body).toEqual({
      accepted: false,
      reasons: [{ code: 'partner_unavailable', message: "This workshop can't take this job right now. Please pick another." }],
    });

    // MetalWorks is suspended between the quote and the start: nothing is started (Review Focus 5).
    const quote = ((await tenant.buyer.post(quotes(tenant), tenant.body({ partner_id: tenant.metalworks })).expect(201)).body as {
      quote: Summary;
    }).quote;
    await tenant.staff.post(`/partners/${tenant.metalworks}/suspend`).expect(200);
    const before = await counts(tenant);
    const blocked = await tenant.staff.post('/workflow/groups', { quote_id: quote.id }).expect(409);
    expect((blocked.body as { title?: string; detail?: string }).detail ?? '').toMatch(/pick again/i);
    expect(await counts(tenant)).toEqual(before);

    // Once it can take jobs again, the same quote starts.
    await tenant.staff.post(`/partners/${tenant.metalworks}/approve`).expect(200);
    await tenant.staff.post('/workflow/groups', { quote_id: quote.id }).expect(201);
  });

  it("keeps naming a workshop to customers the workspace lets pick", async () => {
    const tenant = await freshTenant();
    await tenant.buyer.post(quotes(tenant), tenant.body({ partner_id: tenant.metalworks })).expect(403);
    await tenant.staff.patch(`/customers/${tenant.luna}`, { may_pick_partner: 'yes' }).expect(400);
  });
});
