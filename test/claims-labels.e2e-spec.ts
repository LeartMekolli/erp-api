import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { claimResponseSchema, customerClaimResponseSchema } from '../src/modules/claims/claim-response';
import { CourierEventsService } from '../src/modules/couriers/courier-events.service';
import { COURIER_PROVIDER } from '../src/modules/couriers/courier-provider';
import { signFakeCourierEvent } from '../src/modules/couriers/fake-courier-provider';
import type { FakeCourierProvider } from '../src/modules/couriers/fake-courier-provider';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Order {
  id: string;
  number: number;
  lines: { id: string; position: number; group_id: string }[];
}
interface Label {
  url: string;
  carrier: string;
  service: string;
  tracking: string;
  tracking_status: string | null;
  cost: string;
  currency: string;
}
interface Claim {
  id: string;
  state: string;
  lines: { id: string }[];
  return: { requested_at: string; returned_at: string | null; label: { url: string; tracking: string; tracking_status: string | null } | null } | null;
  shipment: { courier: string | null; tracking: string | null; delivered_at: string | null; label: Label | null } | null;
}
interface Decided extends Claim {
  remake: { group_id: string; unassigned_reasons: string[] } | null;
}
interface OwedJob {
  assignment_id: string;
  group_id: string;
  amount: string;
}

const ACCOUNT = {
  api_key: 'EZTKtest_secret_key_123',
  webhook_secret: 'whsec_courier_test',
  from_address: { name: 'Sol Studio', line1: 'Main street 2', city: 'Munich', postal_code: '80331', country: 'DE' },
};
const PARCEL = { weight_g: 1_200, length_cm: 20, width_cm: 15, height_cm: 10 };
const ADDRESS = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
const d = (value: string) => new Prisma.Decimal(value);

/**
 * Return and remake labels on claims (Orders 3b plan, Task 5): asking the pieces back buys the customer a
 * return label to the workspace, and shipping a remake buys its label, charged to the workshop at fault when
 * every remade line names that one workshop. Stored courier events are applied here with
 * `CourierEventsService.apply`, under a queue prefix no worker reads.
 */
describe('claims: labels', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let events: CourierEventsService;
  let fake: FakeCourierProvider;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;
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

  /**
   * The cast part; the courier account and a live method `live` (FakeCarrier standard, 1.2 kg); CastCo and
   * MetalWorks, each able to make the whole cast line, with a member; Luna Jewels on pay later, with a buyer.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.put('/couriers/account', ACCOUNT).expect(200);
    await staff
      .post('/orders/shipping-methods', { key: 'live', name: 'Tracked courier', live_rate: { carrier: 'FakeCarrier', service: 'standard' }, default_parcel: PARCEL })
      .expect(201);
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;

    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;
    const workshop = async (name: string) => {
      const id = ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
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
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return { id, person: await person(tenant.id, 'partner', id, 'member') };
    };
    const castco = await workshop('CastCo');
    const metalworks = await workshop('MetalWorks');

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    await staff.put(`/customers/${luna}/payment-terms`, { terms: 'pay_later' }).expect(200);
    const buyer = await person(tenant.id, 'customer', luna, 'buyer');

    const quote = async () =>
      (
        (
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
        ).body as { quote: { id: string } }
      ).quote.id;

    /**
     * Luna's order of one line of 10 cast parts for each workshop given, each line made by its workshop,
     * shipped by hand and delivered. Pieces are finished directly: moving them is Workflow's to test.
     */
    const delivered = async (makers: { id: string; person: ReturnType<typeof as> }[]) => {
      const lines = [];
      for (let i = 0; i < makers.length; i += 1) lines.push({ quote_id: await quote() });
      const order = (await staff.post('/orders', { customer_id: luna, lines, address: ADDRESS, shipping_method: 'live' }).expect(201)).body as Order;
      for (const [index, maker] of makers.entries()) {
        const group = order.lines[index].group_id;
        await staff.post(`/partners/jobs/${group}/offer`, { partner_id: maker.id }).expect(201);
        await maker.person.post(`/partner-portal/partners/${maker.id}/jobs/${group}/accept`).expect(200);
      }
      await finish(order.lines.map((line) => line.group_id));
      await staff.post(`/orders/${order.id}/ship`, { courier: 'DHL', tracking: 'JD0001' }).expect(200);
      await staff.post(`/orders/${order.id}/deliver`).expect(200);
      return order;
    };
    const finish = (groupIds: string[]) =>
      prisma.inTenant(tenant.id, (tx) => tx.workOrder.updateMany({ where: { groupId: { in: groupIds } }, data: { status: 'finished', currentStepId: null } }));
    /** Luna's buyer claims 2 pieces of each of the order's lines as faulty. */
    const claim = async (order: Order) =>
      (
        await buyer
          .post(`/portal/customers/${luna}/orders/${order.id}/claims`, {
            reason: 'defect',
            description: 'Cracked shanks.',
            lines: order.lines.map((line) => ({ position: line.position, pieces: 2 })),
          })
          .expect(201)
      ).body as Claim;
    /** Decides every line of the claim a remake at the workshop's fault, and has each workshop accept its own. */
    const remakeAll = async (claimed: Claim, makers: { id: string; person: ReturnType<typeof as> }[]) => {
      const groups: string[] = [];
      for (const [index, line] of claimed.lines.entries()) {
        const decided = (await staff.post(`/claims/${claimed.id}/lines/${line.id}/decision`, { fault: 'workshop', outcome: 'remake' }).expect(200))
          .body as Decided;
        const group = decided.remake!.group_id;
        await makers[index].person.post(`/partner-portal/partners/${makers[index].id}/jobs/${group}/accept`).expect(200);
        groups.push(group);
      }
      await finish(groups);
    };
    /** What `partner` is owed for the job of `group`, as staff see it. */
    const owedFor = async (partner: string, group: string) =>
      ((await staff.get(`/partners/${partner}/owed`).expect(200)).body as { jobs: OwedJob[] }).jobs.find((job) => job.group_id === group)!;
    const labels = (claimId: string) => prisma.inTenant(tenant.id, (tx) => tx.shipment.findMany({ where: { claimId }, orderBy: { createdAt: 'asc' } }));

    return { id: tenant.id, staff, castco, metalworks, luna, buyer, delivered, claim, remakeAll, owedFor, labels };
  }

  /** Sends a signed tracker update and applies the event it stored. */
  async function track(tenantId: string, tracking: string, status: string) {
    const id = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id, description: 'tracker.updated', result: { tracking_code: tracking, status } });
    await http()
      .post(`/webhooks/couriers/${tenantId}`)
      .set('Content-Type', 'application/json')
      .set('X-Hmac-Signature', signFakeCourierEvent(Buffer.from(body), ACCOUNT.webhook_secret))
      .send(body)
      .expect(200);
    const stored = await prisma.inTenant(tenantId, (tx) => tx.courierEvent.findFirstOrThrow({ where: { providerEventId: id } }));
    await events.apply(tenantId, stored.id);
  }

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    events = app.get(CourierEventsService);
    fake = app.get<FakeCourierProvider>(COURIER_PROVIDER);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('gives the customer a return label when staff ask for the pieces back', async () => {
    const w = await workspace();
    const order = await w.delivered([w.castco]);
    const claimed = await w.claim(order);

    const asked = await w.staff.post(`/claims/${claimed.id}/return`, { label: {} }).expect(200);
    expectDocumented(claimResponseSchema, asked.body);
    const label = (asked.body as Claim).return!.label!;
    expect(asked.body).toMatchObject({ state: 'awaiting_return', return: { returned_at: null, label: { tracking: expect.stringMatching(/^FAKE\d{6}$/) } } });
    expect(label.url).toMatch(/^https:\/\/labels\.example\.test\//);
    const [row] = await w.labels(claimed.id);
    expect(row).toMatchObject({ purpose: 'return', status: 'bought', orderId: null, tracking: label.tracking });
    // Asked once: the label isn't bought a second time.
    const boughtBefore = fake.bought.length;
    await w.staff.post(`/claims/${claimed.id}/return`, { label: {} }).expect(409);
    expect(fake.bought.length).toBe(boughtBefore);

    // The customer prints it from the portal.
    const seen = await w.buyer.get(`/portal/customers/${w.luna}/claims/${claimed.id}`).expect(200);
    expectDocumented(customerClaimResponseSchema, seen.body);
    expect((seen.body as Claim).return!.label).toEqual({ url: label.url, tracking: label.tracking, tracking_status: null });

    // Delivered back to the workspace isn't proof the right pieces came: staff still mark them received.
    await track(w.id, label.tracking, 'delivered');
    const tracked = (await w.staff.get(`/claims/${claimed.id}`).expect(200)).body as Claim;
    expect(tracked).toMatchObject({ state: 'awaiting_return', return: { returned_at: null, label: { tracking_status: 'delivered' } } });
    const received = await w.staff.post(`/claims/${claimed.id}/returned`).expect(200);
    expect(received.body).toMatchObject({ state: 'open', return: { returned_at: expect.any(String) } });
  });

  it('ships a remake with a label charged to the workshop at fault', async () => {
    const w = await workspace();
    const order = await w.delivered([w.castco]);
    const originalGroup = order.lines[0].group_id;
    const claimed = await w.claim(order);
    await w.remakeAll(claimed, [w.castco]);
    const before = await w.owedFor(w.castco.id, originalGroup);

    const shipped = await w.staff.post(`/claims/${claimed.id}/ship`, { label: {} }).expect(200);
    expectDocumented(claimResponseSchema, shipped.body);
    const label = (shipped.body as Claim).shipment!.label!;
    expect(label).toMatchObject({ carrier: 'FakeCarrier', service: 'standard', cost: '6.90', currency: 'EUR', tracking_status: null });
    expect(shipped.body).toMatchObject({ state: 'decided', shipment: { courier: 'FakeCarrier', tracking: label.tracking, delivered_at: null } });

    // CastCo is owed the label's cost less for the original job, and the label says which job paid for it.
    const after = await w.owedFor(w.castco.id, originalGroup);
    expect(after.amount).toBe(d(before.amount).sub('6.90').toFixed(2));
    const [row] = await w.labels(claimed.id);
    expect(row).toMatchObject({ purpose: 'remake', status: 'bought', chargedAssignmentId: before.assignment_id, shortfall: null });
    expect(row.owedReduction?.toFixed(2)).toBe('6.90');

    // The courier delivers it: the claim's parcel is delivered, and the claim closed.
    await track(w.id, label.tracking, 'delivered');
    const delivered = await w.staff.get(`/claims/${claimed.id}`).expect(200);
    expectDocumented(claimResponseSchema, delivered.body);
    expect(delivered.body).toMatchObject({ state: 'closed', shipment: { delivered_at: expect.any(String), label: { tracking_status: 'delivered' } } });
    await w.staff.post(`/claims/${claimed.id}/delivered`).expect(409);
    // A repeated delivery changes nothing more.
    await track(w.id, label.tracking, 'delivered');
    expect(((await w.staff.get(`/claims/${claimed.id}`).expect(200)).body as Claim).shipment!.delivered_at).toBe(
      (delivered.body as Claim).shipment!.delivered_at,
    );

    // The customer follows the parcel, never what its label cost.
    const seen = await w.buyer.get(`/portal/customers/${w.luna}/claims/${claimed.id}`).expect(200);
    expectDocumented(customerClaimResponseSchema, seen.body);
    expect(seen.body).toMatchObject({ shipment: { tracking: label.tracking, tracking_status: 'delivered' } });
    expect((seen.body as { shipment: object }).shipment).not.toHaveProperty('label');
  });

  it('leaves the label to the workspace when the remade lines name different workshops', async () => {
    const w = await workspace();
    const order = await w.delivered([w.castco, w.metalworks]);
    const claimed = await w.claim(order);
    await w.remakeAll(claimed, [w.castco, w.metalworks]);
    const castcoBefore = await w.owedFor(w.castco.id, order.lines[0].group_id);
    const metalworksBefore = await w.owedFor(w.metalworks.id, order.lines[1].group_id);

    await w.staff.post(`/claims/${claimed.id}/ship`, { label: {} }).expect(200);
    expect((await w.owedFor(w.castco.id, order.lines[0].group_id)).amount).toBe(castcoBefore.amount);
    expect((await w.owedFor(w.metalworks.id, order.lines[1].group_id)).amount).toBe(metalworksBefore.amount);
    const [row] = await w.labels(claimed.id);
    expect(row).toMatchObject({ purpose: 'remake', status: 'bought', chargedAssignmentId: null, owedReduction: null, shortfall: null });
  });

  it('asks nothing back when the return label fails', async () => {
    const w = await workspace();
    const order = await w.delivered([w.castco]);
    const claimed = await w.claim(order);
    // The fake refuses a label to an address whose first line is FAIL: here the workspace's own.
    await w.staff.put('/couriers/account', { ...ACCOUNT, from_address: { ...ACCOUNT.from_address, line1: 'FAIL' } }).expect(200);

    const refused = await w.staff.post(`/claims/${claimed.id}/return`, { label: {} }).expect(503);
    expect((refused.body as { detail: string }).detail).toBe('The address was refused');
    expect(((await w.staff.get(`/claims/${claimed.id}`).expect(200)).body as Claim)).toMatchObject({ state: 'open', return: null });
    expect(await w.labels(claimed.id)).toEqual([expect.objectContaining({ purpose: 'return', status: 'failed', tracking: null })]);

    // Corrected, the retry buys the label in the same row and asks the pieces back.
    await w.staff.put('/couriers/account', ACCOUNT).expect(200);
    const asked = (await w.staff.post(`/claims/${claimed.id}/return`, { label: {} }).expect(200)).body as Claim;
    expect(asked).toMatchObject({ state: 'awaiting_return', return: { label: { tracking: expect.any(String) } } });
    expect(await w.labels(claimed.id)).toEqual([expect.objectContaining({ purpose: 'return', status: 'bought' })]);
  });
});
