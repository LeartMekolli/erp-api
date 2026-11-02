import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { partnerResponseSchema } from '../src/modules/partners/partner-response';
import { dashboardResponseSchema } from '../src/modules/reporting/dashboard-response';
import { ReportsService } from '../src/modules/reporting/reports.service';
import { addDays, weekOf } from '../src/modules/reporting/week-metrics';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Order {
  id: string;
  number: number;
  lines: { id: string; position: number; total: string; group_id: string }[];
}
interface Claim {
  id: string;
  lines: { id: string }[];
}
interface Production {
  claims: number;
  remakes: number;
}

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const ADDRESS = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Orders 3a, Task 5: pieces claimed at a workshop's fault lower its score's `claims` part, against the
 * pieces it made; the dashboard counts the claims opened and the remakes decided in each week.
 */
describe('claims: the partner score and the dashboard', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let reports: ReportsService;
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

  async function person(tenantId: string, kind: 'customer' | 'partner', organisationId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: kind, organisationId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /** The priced cast part; CastCo able to make the cast line, with a member; Luna Jewels paying by bank transfer, with a buyer. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/payments/account', KEYS).expect(200);

    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;
    const castco = ((await staff.post('/partners', { name: 'CastCo', display_name: 'CastCo' }).expect(201)).body as { id: string }).id;
    await staff
      .put(`/partners/${castco}/capabilities`, {
        capabilities: [printPattern, castingTree, casting, polishing, finalQc, packing].map((step_type_id) => ({ step_type_id, capacity: 200, capacity_period: 'week' })),
      })
      .expect(200);
    await staff.put(`/partners/${castco}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
    await staff.post(`/partners/${castco}/prices/copy-from-workspace`).expect(200);
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
    await staff.put(`/partners/${castco}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
    await staff.post(`/partners/${castco}/approve`).expect(200);
    const castcoPerson = await person(tenant.id, 'partner', castco, 'member');

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const buyer = await person(tenant.id, 'customer', luna, 'buyer');

    /** Luna's order of 10 pieces, paid by bank transfer, made by CastCo unless `inHouse`, then delivered. */
    const delivered = async (options: { inHouse?: boolean } = {}) => {
      const quote = ((
        await staff
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 10,
            file_version_id: cast.versionId,
            customer_id: luna,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote.id;
      const order = (await staff.post('/orders', { customer_id: luna, lines: [{ quote_id: quote }], address: ADDRESS, shipping_method: 'courier' }).expect(201))
        .body as Order;
      await staff.post(`/orders/${order.id}/paid-by-hand`, { reference: `Transfer ${order.number}`, received_on: today() }).expect(200);
      const group = order.lines[0].group_id;
      if (!options.inHouse) {
        await staff.post(`/partners/jobs/${group}/offer`, { partner_id: castco }).expect(201);
        await castcoPerson.post(`/partner-portal/partners/${castco}/jobs/${group}/accept`).expect(200);
      }
      await prisma.inTenant(tenant.id, (tx) => tx.workOrder.updateMany({ where: { groupId: group }, data: { status: 'finished', currentStepId: null } }));
      await staff.post(`/orders/${order.id}/ship`, { courier: 'DHL', tracking: 'JD0001' }).expect(200);
      await staff.post(`/orders/${order.id}/deliver`).expect(200);
      return order;
    };
    /** Luna's buyer claims `pieces` of the order's line as faulty. */
    const claim = async (order: Order, pieces: number) =>
      (
        await buyer
          .post(`/portal/customers/${luna}/orders/${order.id}/claims`, { reason: 'defect', description: 'Cracked shanks.', lines: [{ position: 0, pieces }] })
          .expect(201)
      ).body as Claim;

    return { id: tenant.id, staff, castco, delivered, claim };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const decide = (w: Workspace, claim: Claim, body: object) => w.staff.post(`/claims/${claim.id}/lines/${claim.lines[0].id}/decision`, body).expect(200);
  const claimsPart = async (w: Workspace) => {
    const response = await w.staff.get(`/partners/${w.castco}`).expect(200);
    expectDocumented(partnerResponseSchema, response.body);
    return (response.body as { score: { parts: { claims: number | null } } }).score.parts.claims;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    reports = moduleRef.get(ReportsService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it("counts a claim at the workshop's fault in its score", async () => {
    const w = await workspace();
    const first = await w.delivered();
    // 10 pieces made, none claimed yet.
    expect(await claimsPart(w)).toBe(1);

    const atFault = await w.claim(first, 2);
    // Undecided, it counts against nobody.
    expect(await claimsPart(w)).toBe(1);
    await decide(w, atFault, { fault: 'workshop', outcome: 'refund', refund_amount: '1.00' });
    // 2 of its 10 pieces claimed at its fault.
    expect(await claimsPart(w)).toBeCloseTo(0.8);

    // A claim at the customer's fault on its next order counts the pieces made, not the claim.
    const second = await w.delivered();
    await decide(w, await w.claim(second, 3), { fault: 'customer', outcome: 'refuse', customer_reason: 'The cracks come from a fall.' });
    expect(await claimsPart(w)).toBeCloseTo(1 - 2 / 20);
  });

  it('counts claims and remakes on the dashboard week', async () => {
    const w = await workspace();
    const order = await w.delivered({ inHouse: true });
    const remade = await w.claim(order, 2);
    await w.claim(order, 3);
    await decide(w, remade, { fault: 'workspace', outcome: 'remake' });

    await reports.refresh(w.id, new Date());
    const response = await w.staff.get('/reports/dashboard').expect(200);
    expectDocumented(dashboardResponseSchema, response.body);
    const { current, previous } = response.body as { current: { production: Production }; previous: { production: Production } };
    // Two claims opened this week, one line of them decided a remake; nothing the week before.
    expect(current.production).toMatchObject({ claims: 2, remakes: 1 });
    expect(previous.production).toMatchObject({ claims: 0, remakes: 0 });

    // Any range counts the same way.
    const timezone = (await prisma.tenant.findUniqueOrThrow({ where: { id: w.id } })).timezone;
    const { start } = weekOf(new Date(), timezone);
    expect((await reports.metricsFor(w.id, { from: start, to: addDays(start, 6) })).production).toMatchObject({ claims: 2, remakes: 1 });
  });
});
