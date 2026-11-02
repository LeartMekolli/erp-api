import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { customerPriorityResponseSchema } from '../src/modules/customers/priority/priority-response';
import { PriorityService } from '../src/modules/customers/priority/priority.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { localDate } from '../src/modules/orders/dates';
import { workOrderListItemSchema } from '../src/modules/workflow/work-order-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Piece {
  id: string;
  group_id: string;
}

const DAY_MS = 86_400_000;
const GOLD = { key: 'gold', name: 'Gold', from: 80, firstInLine: true, mayPickPartner: true };
const SILVER = { key: 'silver', name: 'Silver', from: 50, firstInLine: true, mayPickPartner: false };
const SETTINGS = {
  weights: { lifetime: 1, recent: 1, frequency: 1, payment: 1 },
  defaultBand: { key: 'standard', name: 'Standard' },
  bands: [GOLD, SILVER],
};

/**
 * Customers 2, Task 6: what a band unlocks. Bands are given by override here, so nobody needs a history;
 * Gold and Silver are both first in line, Gold above Silver, and only Gold may pick a workshop.
 */
describe('customers: band privileges', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let priority: PriorityService;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  /** The priced cast part, published, the bands set, and Mare, Luna and Sol, all Standard to begin with. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.put('/settings/customers.priority', SETTINGS).expect(200);

    const customer = async (name: string) => ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
    const timezone = (await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).timezone;
    const today = () => localDate(new Date(), timezone);
    return {
      id: tenant.id,
      ownerId: owner.id,
      staff,
      cast,
      mare: await customer('Mare Atelier'),
      luna: await customer('Luna Jewels'),
      sol: await customer('Sol Studio'),
      today,
      /** Starts three pieces for the customer, from a staff quote in its name. */
      start: async (customerId: string) => {
        const quote = ((
          await staff
            .post('/pricing/quotes', {
              product_id: cast.productId,
              options: { material: 'silver_925', finish: 'polished' },
              size: { scale: '1.5' },
              quantity: 3,
              file_version_id: cast.versionId,
              customer_id: customerId,
            })
            .expect(201)
        ).body as { quote: { id: string } }).quote;
        return ((await staff.post('/workflow/groups', { quote_id: quote.id }).expect(201)).body as { id: string }).id;
      },
      override: (customerId: string, band: string) =>
        staff.put(`/customers/${customerId}/priority/override`, { band_key: band, reason: 'Launch partner', ends_on: today() }).expect(200),
    };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  /** Every piece of the work queue, a page of two at a time, each page checked against the docs. */
  async function queue(w: Workspace): Promise<Piece[]> {
    const pieces: Piece[] = [];
    let cursor: string | null = null;
    do {
      const page = await w.staff.get(`/workflow/work-orders?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
      expectDocumented(pageSchema(workOrderListItemSchema), page.body);
      const body = page.body as { data: Piece[]; next_cursor: string | null };
      pieces.push(...body.data);
      cursor = body.next_cursor;
    } while (cursor !== null);
    return pieces;
  }

  /** The queue as the groups its pieces belong to, in order, after checking every piece is there once. */
  async function groupsInQueue(w: Workspace, expected: number): Promise<string[]> {
    const pieces = await queue(w);
    expect(pieces).toHaveLength(expected);
    expect(new Set(pieces.map((piece) => piece.id)).size).toBe(expected);
    return pieces.map((piece) => piece.group_id);
  }

  const three = (groupId: string) => [groupId, groupId, groupId];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    priority = app.get(PriorityService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it("sorts a first-in-line customer's pieces first in the work queue, higher bands first, across pages", async () => {
    const w = await workspace();
    // Sol is Gold before its pieces start; Luna becomes Silver after hers have.
    await w.override(w.sol, 'gold');
    const mare = await w.start(w.mare);
    const luna = await w.start(w.luna);
    const sol = await w.start(w.sol);
    expect(await groupsInQueue(w, 9)).toEqual([...three(sol), ...three(mare), ...three(luna)]);

    await w.override(w.luna, 'silver');
    expect(await groupsInQueue(w, 9)).toEqual([...three(sol), ...three(luna), ...three(mare)]);

    // A band that stops being first in line no longer sorts first, from the moment the settings change.
    await w.staff.put('/settings/customers.priority', { ...SETTINGS, bands: [GOLD, { ...SILVER, firstInLine: false }] }).expect(200);
    expect(await groupsInQueue(w, 9)).toEqual([...three(sol), ...three(mare), ...three(luna)]);

    // Staff see what a band unlocks.
    const gold = await w.staff.get(`/customers/${w.sol}/priority`).expect(200);
    expectDocumented(customerPriorityResponseSchema, gold.body);
    expect(gold.body).toMatchObject({ band: { key: 'gold' }, privileges: { first_in_line: true, may_pick_partner: true } });
    expect((await w.staff.get(`/customers/${w.mare}/priority`).expect(200)).body).toMatchObject({
      band: { key: 'standard' },
      privileges: { first_in_line: false, may_pick_partner: false },
    });
  });

  it('reorders the queue when an override is set and when it ends (Review Focus 4)', async () => {
    const w = await workspace();
    const mare = await w.start(w.mare);
    const sol = await w.start(w.sol);
    expect(await groupsInQueue(w, 6)).toEqual([...three(mare), ...three(sol)]);

    await w.override(w.sol, 'gold');
    expect(await groupsInQueue(w, 6)).toEqual([...three(sol), ...three(mare)]);

    // Its last day is over: the band reads Standard at once, and the queue follows at the next nightly run.
    const yesterday = new Date(new Date(`${w.today()}T00:00:00Z`).getTime() - DAY_MS);
    await prisma.inTenant(w.id, (tx) =>
      tx.customerPriority.update({ where: { tenantId_customerId: { tenantId: w.id, customerId: w.sol } }, data: { overrideEndsOn: yesterday } }),
    );
    await priority.refresh(w.id, new Date());
    expect(await groupsInQueue(w, 6)).toEqual([...three(mare), ...three(sol)]);

    // Removing an override reorders at once.
    await w.override(w.sol, 'gold');
    expect(await groupsInQueue(w, 6)).toEqual([...three(sol), ...three(mare)]);
    await w.staff.delete(`/customers/${w.sol}/priority/override`).expect(204);
    expect(await groupsInQueue(w, 6)).toEqual([...three(mare), ...three(sol)]);
  });

  it('lets a band pick a workshop without the per-customer switch', async () => {
    const w = await workspace();
    const { printPattern, castingTree, casting, polishing } = w.cast.steps;
    const { finalQc, packing } = w.cast.workflow.notPriced;
    // MetalWorks takes direct orders and the whole cast line.
    const metalworks = ((await w.staff.post('/partners', { name: 'MetalWorks Ltd', display_name: 'MetalWorks' }).expect(201)).body as { id: string }).id;
    await w.staff
      .put(`/partners/${metalworks}/capabilities`, {
        capabilities: [printPattern, castingTree, casting, polishing, finalQc, packing].map((step_type_id) => ({ step_type_id, capacity: 200, capacity_period: 'week' })),
      })
      .expect(200);
    await w.staff.put(`/partners/${metalworks}/offerings`, { option_value_ids: [w.cast.v.silver, w.cast.v.polished] }).expect(200);
    await w.staff.post(`/partners/${metalworks}/prices/copy-from-workspace`).expect(200);
    await w.staff.patch(`/partners/${metalworks}/limits`, { accepts_direct_orders: true }).expect(200);
    const agreement = (await measuredDesign(prisma, w.id, w.ownerId, { status: 'uploaded', measures: [] })).versionId;
    await w.staff.put(`/partners/${metalworks}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
    await w.staff.post(`/partners/${metalworks}/approve`).expect(200);

    const buyerOf = async (customerId: string) => {
      const user = await createTestUser(prisma, w.id, { roles: [] });
      await prisma.inTenant(w.id, async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { kind: 'customer' } });
        await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'customer', organisationId: customerId, role: 'buyer' } });
      });
      const design = (await measuredDesign(prisma, w.id, w.ownerId, { customerId })).versionId;
      const buyer = as((await tokens.issueForUser(w.id, user.id)).accessToken);
      const body = {
        product_id: w.cast.productId,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        file_version_id: design,
        quantity: 10,
      };
      return {
        choices: () => buyer.post(`/portal/customers/${customerId}/quotes/partners`, body),
        quote: () => buyer.post(`/portal/customers/${customerId}/quotes`, { ...body, partner_id: metalworks }),
      };
    };
    const sol = await buyerOf(w.sol);
    const mare = await buyerOf(w.mare);

    // Sol is Gold, which may pick; its own switch stays off.
    await w.override(w.sol, 'gold');
    await sol.choices().expect(200);
    await sol.quote().expect(201);
    expect((await w.staff.get(`/customers/${w.sol}`).expect(200)).body).toMatchObject({ may_pick_partner: false, band: { key: 'gold' } });

    // Mare is Standard: the existing refusal.
    await mare.choices().expect(403);
    await mare.quote().expect(403);

    // Once Sol's override is gone, so is the privilege.
    await w.staff.delete(`/customers/${w.sol}/priority/override`).expect(204);
    await sol.quote().expect(403);
  });
});
