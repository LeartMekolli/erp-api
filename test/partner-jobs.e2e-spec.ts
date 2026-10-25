import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { OfferExpiryHandler } from '../src/modules/partners/offer-expiry.handler';
import {
  eligiblePartnersResponseSchema,
  jobAssignmentResponseSchema,
  jobHistoryResponseSchema,
} from '../src/modules/partners/partner-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Eligible {
  data: { partner: { id: string; name: string }; cost: string; margin: string; room: { step_key: string; left: number }[]; score: { overall: number | null } }[];
  ineligible: { partner: { id: string; name: string }; reasons: string[] }[];
}
interface Assignment {
  id: string;
  partner: { id: string; name: string };
  kind: string;
  status: string;
  cost: string;
  owed_override: { amount: string; reason: string } | null;
  expires_at: string | null;
}

/**
 * Who can take a job, and offering it (Partners spec, goals 9 and 10; plan Review Focus 3 and 4):
 * eligible partners ranked by cost with margin and room, one open offer per job, accept or decline
 * before the deadline, expiry, and moving an accepted job to another partner.
 */
describe('partners: eligible partners, offers and assignments', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let expiry: OfferExpiryHandler;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none, so silver is at its fallback.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

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
   * The priced cast part and three approved partners with the workspace's prices: CastCo (casting
   * setup 30), MetalWorks (casting setup 50) and PrintLab, which can't polish. Three jobs of 10 silver
   * polished pieces each, started from quotes.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;

    const partner = async (name: string, stepTypeIds: string[], castingSetup: string) => {
      const id = ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
      await staff
        .put(`/partners/${id}/capabilities`, {
          capabilities: stepTypeIds.map((step_type_id) => ({ step_type_id, capacity: 200, capacity_period: 'week' })),
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
      const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return id;
    };
    const castco = await partner('CastCo', [printPattern, castingTree, casting, polishing, finalQc, packing], '30');
    const metalworks = await partner('MetalWorks', [printPattern, castingTree, casting, polishing, finalQc, packing], '50');
    const printlab = await partner('PrintLab', [printPattern, castingTree, casting, finalQc, packing], '30');

    const job = async () => {
      const quoted = await staff
        .post('/pricing/quotes', {
          product_id: cast.productId,
          options: { material: 'silver_925', finish: 'polished' },
          size: { scale: '1.5' },
          file_version_id: cast.versionId,
          quantity: 10,
        })
        .expect(201);
      const quote = (quoted.body as { quote: { id: string; total: string } }).quote;
      const group = ((await staff.post('/workflow/groups', { quote_id: quote.id }).expect(201)).body as { id: string }).id;
      return { group, total: quote.total };
    };

    return {
      id: tenant.id,
      staff,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      castco,
      metalworks,
      printlab,
      jobs: [await job(), await job(), await job()],
      castcoPerson: await partnerPerson(tenant.id, castco, 'member'),
      metalworksPerson: await partnerPerson(tenant.id, metalworks, 'member'),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const eligibleFor = async (tenant: Tenant, group: string): Promise<Eligible> => {
    const response = await tenant.staff.get(`/partners/eligible?group_id=${group}`).expect(200);
    expectDocumented(eligiblePartnersResponseSchema, response.body);
    return response.body as Eligible;
  };
  /** What CastCo has left at casting, as staff see it for `group`. */
  const castingLeft = async (tenant: Tenant, group: string) =>
    (await eligibleFor(tenant, group)).data
      .find((row) => row.partner.id === tenant.castco)!
      .room.find((step) => step.step_key === 'casting')!.left;
  const offer = (tenant: Tenant, group: string, partner_id: string) =>
    tenant.staff.post(`/partners/jobs/${group}/offer`, { partner_id });
  const notifications = (tenant: Tenant, eventKey: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey } }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    expiry = moduleRef.get(OfferExpiryHandler);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('lists the partners who can take a job, cheapest first, with their cost, margin and room', async () => {
    const tenant = await freshTenant();
    const [first] = tenant.jobs;

    const eligible = await eligibleFor(tenant, first.group);
    expect(eligible.data.map((row) => row.partner.name)).toEqual(['CastCo', 'MetalWorks']);
    const [castco, metalworks] = eligible.data;
    // MetalWorks' casting setup is 20 more for the run of 10.
    expect(new Prisma.Decimal(metalworks.cost).minus(castco.cost).toFixed(2)).toBe('20.00');
    expect(castco.margin).toBe(new Prisma.Decimal(first.total).minus(castco.cost).toFixed(2));
    // No finished jobs yet: "new".
    expect(castco.score.overall).toBeNull();
    expect(castco.room.map((step) => step.step_key)).toEqual([
      'print_pattern',
      'casting_tree',
      'casting',
      'polishing',
      'final_qc',
      'packing',
    ]);
    // The other two jobs are not offered to anyone, so they take no room.
    expect(castco.room.every((step) => step.left === 190)).toBe(true);

    expect(eligible.ineligible).toEqual([
      { partner: { id: tenant.printlab, name: 'PrintLab' }, reasons: expect.arrayContaining(['No capability for polishing']) },
    ]);
  });

  it('offers a job to one partner at a time, who accepts or declines it', async () => {
    const tenant = await freshTenant();
    const [first, , watch] = tenant.jobs;
    const portal = `/partner-portal/partners/${tenant.castco}/jobs/${first.group}`;

    const offered = await offer(tenant, first.group, tenant.castco).expect(201);
    expectDocumented(jobAssignmentResponseSchema, offered.body);
    expect(offered.body).toMatchObject({ partner: { id: tenant.castco }, kind: 'offer', status: 'offered', owed_override: null });
    const expiresIn = new Date((offered.body as Assignment).expires_at!).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(23 * 3_600_000);
    expect(expiresIn).toBeLessThanOrEqual(24 * 3_600_000);
    expect(await notifications(tenant, 'partner.job.offered')).toBe(1);
    // An open offer holds CastCo's room for the 10 pieces.
    expect(await castingLeft(tenant, watch.group)).toBe(180);

    // One open offer per job.
    await offer(tenant, first.group, tenant.castco).expect(409);
    await offer(tenant, first.group, tenant.metalworks).expect(409);
    // Only the partner offered answers; MetalWorks has nothing to answer.
    await tenant.metalworksPerson.post(`/partner-portal/partners/${tenant.metalworks}/jobs/${first.group}/accept`).expect(404);

    const declined = await tenant.castcoPerson.post(`${portal}/decline`).expect(200);
    expectDocumented(jobAssignmentResponseSchema, declined.body);
    expect(declined.body).toMatchObject({ status: 'declined' });
    expect(await notifications(tenant, 'partner.job.declined')).toBe(1);
    expect(await castingLeft(tenant, watch.group)).toBe(190);
    await tenant.castcoPerson.post(`${portal}/accept`).expect(409);

    await offer(tenant, first.group, tenant.castco).expect(201);
    const accepted = await tenant.castcoPerson.post(`${portal}/accept`).expect(200);
    expect(accepted.body).toMatchObject({ status: 'accepted' });
    await tenant.castcoPerson.post(`${portal}/accept`).expect(409);
    await tenant.castcoPerson.post(`${portal}/decline`).expect(409);
    await offer(tenant, first.group, tenant.metalworks).expect(409);
    expect(await castingLeft(tenant, watch.group)).toBe(180);

    const history = await tenant.staff.get(`/partners/jobs/${first.group}`).expect(200);
    expectDocumented(jobHistoryResponseSchema, history.body);
    expect((history.body as { data: Assignment[] }).data.map((row) => row.status)).toEqual(['declined', 'accepted']);
  });

  it('lets only one of two offers made at the same moment through', async () => {
    const tenant = await freshTenant();
    const [first] = tenant.jobs;

    const responses = await Promise.all([offer(tenant, first.group, tenant.castco), offer(tenant, first.group, tenant.metalworks)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const history = (await tenant.staff.get(`/partners/jobs/${first.group}`).expect(200)).body as { data: Assignment[] };
    expect(history.data.map((row) => row.status)).toEqual(['offered']);

    // Withdrawn, it can be offered again.
    const withdrawn = await tenant.staff.post(`/partners/jobs/${first.group}/withdraw`).expect(200);
    expect(withdrawn.body).toMatchObject({ status: 'withdrawn' });
    await tenant.staff.post(`/partners/jobs/${first.group}/withdraw`).expect(409);
    await offer(tenant, first.group, tenant.castco).expect(201);
  });

  it('decides an offer is over by its deadline, before the expiry run, and the run frees the room', async () => {
    const tenant = await freshTenant();
    const [first, , watch] = tenant.jobs;
    const offered = (await offer(tenant, first.group, tenant.castco).expect(201)).body as Assignment;

    await prisma.inTenant(tenant.id, (tx) =>
      tx.jobAssignment.update({ where: { id: offered.id }, data: { expiresAt: new Date(Date.now() - 1_000) } }),
    );
    await tenant.castcoPerson.post(`/partner-portal/partners/${tenant.castco}/jobs/${first.group}/accept`).expect(409);

    await expiry.handle();
    const history = (await tenant.staff.get(`/partners/jobs/${first.group}`).expect(200)).body as { data: Assignment[] };
    expect(history.data.map((row) => row.status)).toEqual(['expired']);
    expect(await notifications(tenant, 'partner.job.expired')).toBe(1);
    expect(await castingLeft(tenant, watch.group)).toBe(190);

    // A second run finds nothing more to expire.
    await expiry.handle();
    expect(await notifications(tenant, 'partner.job.expired')).toBe(1);
    await offer(tenant, first.group, tenant.metalworks).expect(201);
  });

  it('moves an accepted job to another partner, keeping what the first is owed', async () => {
    const tenant = await freshTenant();
    const [first] = tenant.jobs;

    // Only an accepted job is moved.
    await tenant.staff.post(`/partners/jobs/${first.group}/reassign`, { partner_id: tenant.metalworks }).expect(409);
    await offer(tenant, first.group, tenant.castco).expect(201);
    await tenant.castcoPerson.post(`/partner-portal/partners/${tenant.castco}/jobs/${first.group}/accept`).expect(200);

    const owed = { amount: '40.00', reason: 'Cast before the breakdown' };
    await tenant.staff.post(`/partners/jobs/${first.group}/reassign`, { partner_id: tenant.castco }).expect(409);
    await tenant.staff.post(`/partners/jobs/${first.group}/reassign`, { partner_id: tenant.printlab }).expect(409);
    await tenant.staff
      .post(`/partners/jobs/${first.group}/reassign`, { partner_id: tenant.metalworks, previous_owed: { amount: '40.00' } })
      .expect(400);
    const moved = await tenant.staff
      .post(`/partners/jobs/${first.group}/reassign`, { partner_id: tenant.metalworks, previous_owed: owed })
      .expect(201);
    expectDocumented(jobAssignmentResponseSchema, moved.body);
    expect(moved.body).toMatchObject({ partner: { id: tenant.metalworks }, kind: 'reassign', status: 'accepted' });

    const history = (await tenant.staff.get(`/partners/jobs/${first.group}`).expect(200)).body as { data: Assignment[] };
    expect(history.data.map((row) => [row.partner.name, row.kind, row.status, row.owed_override])).toEqual([
      ['CastCo', 'offer', 'replaced', owed],
      ['MetalWorks', 'reassign', 'accepted', null],
    ]);
  });

  it('keeps jobs to staff who may assign them, in their own workspace', async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const [first] = tenant.jobs;

    await tenant.member.get(`/partners/eligible?group_id=${first.group}`).expect(403);
    await tenant.member.post(`/partners/jobs/${first.group}/offer`, { partner_id: tenant.castco }).expect(403);
    await tenant.castcoPerson.get(`/partners/eligible?group_id=${first.group}`).expect(403);

    await tenant.staff.get(`/partners/eligible?group_id=${other.jobs[0].group}`).expect(404);
    await tenant.staff.get(`/partners/eligible?group_id=${newId()}`).expect(404);
    await tenant.staff.get('/partners/eligible?group_id=nope').expect(400);
    await offer(tenant, other.jobs[0].group, tenant.castco).expect(404);
    await offer(tenant, first.group, other.castco).expect(404);
    await tenant.staff.get(`/partners/jobs/${other.jobs[0].group}`).expect(404);
    // Another workspace's partner person can't answer this workspace's offer.
    await offer(tenant, first.group, tenant.castco).expect(201);
    await other.castcoPerson.post(`/partner-portal/partners/${tenant.castco}/jobs/${first.group}/accept`).expect(404);
  });
});
