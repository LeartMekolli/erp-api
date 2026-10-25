import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import {
  customerRatingResponseSchema,
  eligiblePartnersResponseSchema,
  partnerChoicesResponseSchema,
  partnerRatingsResponseSchema,
  partnerResponseSchema,
  partnerScoreResponseSchema,
  ratingResponseSchema,
} from '../src/modules/partners/partner-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Score {
  overall: number | null;
  parts: { quality: number | null; scrap: number | null; reliability: number | null; on_time: number | null; rating: number | null };
  finished_jobs: number;
}
interface Rating {
  id: string;
  group_id: string;
  customer: { id: string; name: string };
  stars: number;
  comment: string | null;
  shared_with_partner: boolean;
}
interface PortalScore {
  score: Score;
  ratings: { id: string; group_id: string; stars: number; comment: string | null }[];
}

/**
 * Customer ratings and the partner score (Partners spec, goals 15 and 16; P14, P15): a customer's buyer
 * rates a finished job once; partners see their stars and only the comments staff share, never the
 * customer; the score mixes quality, scrap, reliability and rating, by the workspace's weights, and is
 * "new" until a partner has finished 5 jobs.
 */
describe('partners: ratings and score', () => {
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
  type Client = ReturnType<typeof as>;

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
   * The priced cast part, published, every step the partner's; CastCo (casting setup 30, takes direct
   * orders) and MetalWorks (the workspace's prices), both approved for the whole line; Luna Jewels with
   * a buyer and a viewer, and Sol with a buyer.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;

    const partner = async (name: string, castingSetup: string | null) => {
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
      if (castingSetup) {
        await staff
          .put(`/partners/${id}/step-types/${casting}/prices`, {
            failure_percent: '0',
            blocks: [
              { kind: 'material', source: { configuration: true }, basis: 'weight', loss_percent: '5' },
              { kind: 'setup', amount: castingSetup },
            ],
          })
          .expect(200);
        await staff.patch(`/partners/${id}/limits`, { accepts_direct_orders: true }).expect(200);
      }
      const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return id;
    };
    const castco = await partner('CastCo', '30');
    const metalworks = await partner('MetalWorks', null);

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const sol = ((await staff.post('/customers', { name: 'Sol Studio' }).expect(201)).body as { id: string }).id;
    const design = (await measuredDesign(prisma, tenant.id, owner.id, { customerId: luna })).versionId;
    const photo = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
    const castcoPerson = await person(tenant.id, 'partner', castco, 'member');

    const configuration = {
      product_id: cast.productId,
      options: { material: 'silver_925', finish: 'polished' },
      size: { scale: '1.5' },
    };
    /** Luna's job of `quantity` rings, started; offered to CastCo and accepted, unless `offerTo` is null. */
    const job = async (quantity: number, offerTo: string | null = castco) => {
      const quoted = await staff
        .post('/pricing/quotes', { ...configuration, file_version_id: cast.versionId, quantity, customer_id: luna })
        .expect(201);
      const quoteId = (quoted.body as { quote: { id: string } }).quote.id;
      const group = ((await staff.post('/workflow/groups', { quote_id: quoteId }).expect(201)).body as { id: string }).id;
      if (offerTo) {
        await staff.post(`/partners/jobs/${group}/offer`, { partner_id: offerTo }).expect(201);
        await castcoPerson.post(`/partner-portal/partners/${castco}/jobs/${group}/accept`).expect(200);
      }
      return group;
    };

    return {
      id: tenant.id,
      staff,
      cast,
      castco,
      metalworks,
      luna,
      sol,
      photo,
      job,
      castcoPerson,
      body: { ...configuration, file_version_id: design, quantity: 10 },
      buyer: await person(tenant.id, 'customer', luna, 'buyer'),
      viewer: await person(tenant.id, 'customer', luna, 'viewer'),
      solBuyer: await person(tenant.id, 'customer', sol, 'buyer'),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const surfaceOk = [{ item: 'surface', value: 'ok' }];
  const steps = ['print_pattern', 'casting_tree', 'casting', 'polishing', 'final_qc', 'packing'];

  /**
   * Every piece of the job through every step, by `mover` at `movesPath`; with `scratch`, the first
   * piece fails polishing once and is reworked there first.
   */
  async function finish(tenant: Tenant, group: string, mover: Client, movesPath: string, scratch = false) {
    const ids = ((await tenant.staff.get(`/workflow/work-orders?group_id=${group}&limit=100`).expect(200)).body as { data: { id: string }[] }).data.map(
      (piece) => piece.id,
    );
    const extra: Record<string, object> = {
      polishing: { answers: surfaceOk },
      final_qc: { answers: [{ item: 'weight', value: '5.0' }], photo_file_version_ids: [tenant.photo] },
    };
    for (const at_step of steps) {
      if (scratch && at_step === 'polishing') {
        await mover
          .post(movesPath, { work_order_ids: [ids[0]], kind: 'fail', at_step, defect_id: tenant.cast.workflow.defects.scratch, comment: 'Scratched' })
          .expect(200);
      }
      await mover.post(movesPath, { work_order_ids: ids, kind: 'pass', at_step, ...(extra[at_step] ?? {}) }).expect(200);
    }
  }
  const finishByCastco = (tenant: Tenant, group: string, scratch = false) =>
    finish(tenant, group, tenant.castcoPerson, `/partner-portal/partners/${tenant.castco}/moves`, scratch);

  const rate = (client: Client, customerId: string, group: string, body: object) =>
    client.post(`/portal/customers/${customerId}/jobs/${group}/rating`, body);
  const portalScore = async (tenant: Tenant) => {
    const response = await tenant.castcoPerson.get(`/partner-portal/partners/${tenant.castco}/score`).expect(200);
    expectDocumented(partnerScoreResponseSchema, response.body);
    return response;
  };
  const staffScore = async (tenant: Tenant, partnerId: string) => {
    const response = await tenant.staff.get(`/partners/${partnerId}`).expect(200);
    expectDocumented(partnerResponseSchema, response.body);
    return (response.body as { score: Score }).score;
  };

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

  it("lets a customer's buyer rate a finished job once, and shows the partner only the comments staff share", async () => {
    const tenant = await freshTenant();
    const group = await tenant.job(2);
    const comment = 'Lovely finish, thank you from the Luna team';

    // Not finished yet.
    await rate(tenant.buyer, tenant.luna, group, { stars: 4, comment }).expect(409);
    await finishByCastco(tenant, group);

    // A viewer can't rate; another customer's people don't see the job; stars are whole, 1 to 5.
    await rate(tenant.viewer, tenant.luna, group, { stars: 4 }).expect(403);
    await rate(tenant.solBuyer, tenant.sol, group, { stars: 4 }).expect(404);
    for (const stars of [0, 6, 2.5, '4']) {
      await rate(tenant.buyer, tenant.luna, group, { stars }).expect(400);
    }
    await rate(tenant.buyer, tenant.luna, group, { stars: 4, comment: 'x'.repeat(2001) }).expect(400);

    const rated = await rate(tenant.buyer, tenant.luna, group, { stars: 4, comment }).expect(201);
    expectDocumented(customerRatingResponseSchema, rated.body);
    expect(rated.body).toMatchObject({ group_id: group, stars: 4, comment });
    // Once only.
    await rate(tenant.buyer, tenant.luna, group, { stars: 5 }).expect(409);

    // A job made in-house has no partner to rate.
    const inHouse = await tenant.job(1, null);
    await finish(tenant, inHouse, tenant.staff, '/workflow/moves');
    await rate(tenant.buyer, tenant.luna, inHouse, { stars: 5 }).expect(409);

    // CastCo sees its stars, not the comment, and nothing naming Luna.
    let mine = await portalScore(tenant);
    expect((mine.body as PortalScore).ratings).toEqual([expect.objectContaining({ group_id: group, stars: 4, comment: null })]);
    for (const secret of [comment, tenant.luna, 'Luna Jewels']) {
      expect({ secret, found: mine.text.includes(secret) }).toEqual({ secret, found: false });
    }

    // Staff see every rating with its customer and comment.
    const listed = await tenant.staff.get(`/partners/${tenant.castco}/ratings`).expect(200);
    expectDocumented(partnerRatingsResponseSchema, listed.body);
    const [rating] = (listed.body as { data: Rating[] }).data;
    expect(rating).toMatchObject({
      group_id: group,
      customer: { id: tenant.luna, name: 'Luna Jewels' },
      stars: 4,
      comment,
      shared_with_partner: false,
    });
    await tenant.castcoPerson.get(`/partners/${tenant.castco}/ratings`).expect(403);

    // Staff share the comment: CastCo sees it, still without Luna.
    const shared = await tenant.staff.post(`/partners/ratings/${rating.id}/share`).expect(200);
    expectDocumented(ratingResponseSchema, shared.body);
    expect(shared.body).toMatchObject({ id: rating.id, shared_with_partner: true });
    mine = await portalScore(tenant);
    expect((mine.body as PortalScore).ratings).toEqual([expect.objectContaining({ id: rating.id, stars: 4, comment })]);
    for (const secret of [tenant.luna, 'Luna Jewels']) {
      expect({ secret, found: mine.text.includes(secret) }).toEqual({ secret, found: false });
    }

    await tenant.staff.post('/partners/ratings/0190a1b2-0000-7000-8000-000000000000/share').expect(404);
    await tenant.castcoPerson.post(`/partners/ratings/${rating.id}/share`).expect(403);
    await tenant.castcoPerson.get(`/partner-portal/partners/${tenant.metalworks}/score`).expect(404);
  });

  it('scores a partner from its work and its ratings once it has finished 5 jobs, by the workspace weights', async () => {
    const tenant = await freshTenant();
    const jobs: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      jobs.push(await tenant.job(2));
    }
    // A sixth job CastCo turns down.
    const declined = await tenant.job(2, null);
    await tenant.staff.post(`/partners/jobs/${declined}/offer`, { partner_id: tenant.castco }).expect(201);
    await tenant.castcoPerson.post(`/partner-portal/partners/${tenant.castco}/jobs/${declined}/decline`).expect(200);

    // Four jobs finished, one ring scratched once at polishing: "new", but the parts show.
    await finishByCastco(tenant, jobs[0], true);
    for (const group of jobs.slice(1, 4)) {
      await finishByCastco(tenant, group);
    }
    let score = await staffScore(tenant, tenant.castco);
    expect(score.overall).toBeNull();
    expect(score.finished_jobs).toBe(4);
    // 8 rings × 6 steps, one of them not passed first time.
    expect(score.parts.quality).toBeCloseTo(47 / 48);
    expect(score.parts.scrap).toBe(1);
    // 5 offers accepted, 1 declined.
    expect(score.parts.reliability).toBeCloseTo(5 / 6);
    expect(score.parts.on_time).toBeNull();
    expect(score.parts.rating).toBeNull();

    // Luna rates two jobs, and CastCo finishes its fifth.
    await rate(tenant.buyer, tenant.luna, jobs[0], { stars: 5 }).expect(201);
    await rate(tenant.buyer, tenant.luna, jobs[1], { stars: 3, comment: 'A bit late' }).expect(201);
    await finishByCastco(tenant, jobs[4]);

    // (3 × 59/60 + 2 × 1 + 2 × 5/6 + 3 × 0.75) / 10 × 5 = 4.43.
    score = await staffScore(tenant, tenant.castco);
    expect(score).toMatchObject({ overall: 4.4, finished_jobs: 5 });
    expect(score.parts.quality).toBeCloseTo(59 / 60);
    expect(score.parts.rating).toBeCloseTo(0.75);
    expect((await staffScore(tenant, tenant.metalworks)).overall).toBeNull();

    // CastCo sees the same score and parts.
    const mine = (await portalScore(tenant)).body as PortalScore;
    expect(mine.score).toEqual(score);
    expect(mine.ratings.map((rating) => [rating.stars, rating.comment])).toEqual([
      [3, null],
      [5, null],
    ]);

    // Staff rank by score, then cost: CastCo first, though its casting costs more.
    const eligible = await tenant.staff.get(`/partners/eligible?group_id=${declined}`).expect(200);
    expectDocumented(eligiblePartnersResponseSchema, eligible.body);
    const rows = (eligible.body as { data: { partner: { name: string }; cost: string; score: Score }[] }).data;
    expect(rows.map((row) => [row.partner.name, row.score.overall])).toEqual([
      ['CastCo Ltd', 4.4],
      ['MetalWorks Ltd', null],
    ]);
    expect(new Prisma.Decimal(rows[0].cost).greaterThan(rows[1].cost)).toBe(true);

    // Customers see only the overall score.
    await tenant.staff.patch(`/customers/${tenant.luna}`, { may_pick_partner: true }).expect(200);
    const choices = await tenant.buyer.post(`/portal/customers/${tenant.luna}/quotes/partners`, tenant.body).expect(200);
    expectDocumented(partnerChoicesResponseSchema, choices.body);
    expect((choices.body as { data: { partner: { display_name: string }; score: number | null }[] }).data).toEqual([
      expect.objectContaining({ partner: expect.objectContaining({ display_name: 'CastCo' }), score: 4.4 }),
    ]);
    for (const secret of ['quality', 'reliability', 'finished_jobs']) {
      expect({ secret, found: choices.text.includes(secret) }).toEqual({ secret, found: false });
    }

    // The workspace weighs only ratings: 0.75 × 5 = 3.75.
    await tenant.staff.put('/settings/partners.scoreWeights', { quality: 0, scrap: 0, reliability: 0, onTime: 0, rating: 1 }).expect(200);
    expect((await staffScore(tenant, tenant.castco)).overall).toBe(3.8);
  });
});
