import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { quoteResponseSchema, quoteResultResponseSchema, quoteSummaryResponseSchema } from '../src/modules/pricing/quote-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import type { PricedCastPart } from './pricing-fixtures';

interface Summary {
  id: string;
  quantity: number;
  currency: string;
  lines: { label: string; amount: string }[];
  unit_price: string;
  total: string;
  expired: boolean;
}
interface Staff {
  id: string;
  unit_price: string;
  total: string;
  expired: boolean;
  materials: { key: string; unit_price: string; source: string }[];
  breakdown: {
    steps: { key: string; blocks: { kind: string; quantity?: string; unit?: string }[] }[];
    adjustments: { kind: string; percent: string; amount: string }[];
  };
}
interface Refused {
  accepted: false;
  reasons: { code: string; message: string; step?: string; rule_id?: string }[];
}

describe('pricing: saved quotes', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none, so silver is at its fallback.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const as = (token: string) => ({
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    });
    return {
      id: tenant.id,
      ownerId: owner.id,
      owner: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken),
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const walkthrough = (tenant: Tenant) =>
    pricedCastPart(tenant.owner, prisma, { id: tenant.id, staffUserId: tenant.ownerId, runMetal });
  type Setup = PricedCastPart;

  const silverPolished = (setup: Setup, extra: object = {}) => ({
    product_id: setup.productId,
    options: { material: 'silver_925', finish: 'polished' },
    size: { scale: '1.5' },
    file_version_id: setup.versionId,
    quantity: 1,
    ...extra,
  });

  async function quote(as: Tenant['owner'], body: object): Promise<Summary> {
    const response = await as.post('/pricing/quotes', body).expect(201);
    expectDocumented(quoteResultResponseSchema, response.body);
    return (response.body as { quote: Summary }).quote;
  }

  const quoteCount = (tenantId: string) => prisma.inTenant(tenantId, (tx) => tx.quote.count());

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

  it('quotes one piece with every step, and twenty for less each', async () => {
    const tenant = await freshTenant();
    const setup = await walkthrough(tenant);

    const one = await quote(tenant.owner, silverPolished(setup));
    // Steps 3.405 + 57 + 46.2062625 + 9.25, + overhead 2, × 1.4 = 165.0057675.
    expect(one).toMatchObject({ quantity: 1, currency: expect.any(String), unit_price: '165.01', total: '165.01', expired: false });
    const sum = one.lines.reduce((total, line) => total + Math.round(Number(line.amount) * 100), 0);
    expect(sum).toBe(16501);

    const staff = await tenant.owner.get(`/pricing/quotes/${one.id}`).expect(200);
    expectDocumented(quoteResponseSchema, staff.body);
    const view = staff.body as Staff;
    expect(view.breakdown.steps.map((step) => step.key)).toEqual(['print_pattern', 'casting_tree', 'casting', 'polishing']);
    const casting = view.breakdown.steps.find((step) => step.key === 'casting')!;
    expect(casting.blocks[0]).toMatchObject({ kind: 'material', quantity: '34.965', unit: 'g' });
    expect(view.materials.map((material) => [material.key, material.unit_price, material.source]).sort()).toEqual([
      ['pattern_resin', '0.12', 'manual'],
      ['silver_925', '0.85', 'fallback'],
    ]);

    const summary = await tenant.owner.get(`/pricing/quotes/${one.id}/summary`).expect(200);
    expectDocumented(quoteSummaryResponseSchema, summary.body);
    expect(summary.body).toMatchObject({ id: one.id, product: { id: setup.productId, name: 'Custom cast part' }, unit_price: '165.01' });

    // Shared tree and setup, then the 10+ tier: 77.2257675 − 5 % = 73.364479125.
    const twenty = await quote(tenant.owner, silverPolished(setup, { quantity: 20 }));
    expect(twenty).toMatchObject({ quantity: 20, unit_price: '73.36', total: '1467.20' });
    expect(twenty.lines.map((line) => line.label)).toContain('quantity_discount');

    const list = await tenant.owner.get('/pricing/quotes').expect(200);
    expect((list.body as { data: { id: string }[] }).data.map((row) => row.id)).toEqual([twenty.id, one.id]);
  });

  it('adds and removes steps by option, and applies the speed and group named', async () => {
    const tenant = await freshTenant();
    const setup = await walkthrough(tenant);
    const stepsOf = async (summary: Summary) =>
      ((await tenant.owner.get(`/pricing/quotes/${summary.id}`).expect(200)).body as Staff).breakdown.steps.map((step) => step.key);

    const plated = await quote(tenant.owner, silverPolished(setup, { options: { material: 'silver_925', finish: 'gold_plated' } }));
    expect(await stepsOf(plated)).toEqual(['print_pattern', 'casting_tree', 'casting', 'polishing', 'plating']);
    // Plating 13.5 cm² × 0.4 = 5.4 more cost, × 1.4.
    expect(Number(plated.unit_price)).toBeCloseTo(165.01 + 7.56, 2);

    const raw = await quote(tenant.owner, silverPolished(setup, { options: { material: 'silver_925', finish: 'raw' } }));
    expect(await stepsOf(raw)).toEqual(['print_pattern', 'casting_tree', 'casting']);

    const rush = await quote(tenant.owner, silverPolished(setup, { delivery_speed: 'rush', customer_group: 'trade' }));
    const adjustments = ((await tenant.owner.get(`/pricing/quotes/${rush.id}`).expect(200)).body as Staff).breakdown.adjustments;
    expect(adjustments.map((line) => [line.kind, line.percent])).toEqual([
      ['customer_group', '-10'],
      ['delivery_speed', '30'],
    ]);
    expect(rush.lines.map((line) => line.label)).toEqual(['material', 'making', 'finishing', 'your_discount', 'delivery_speed']);
  });

  it('refuses without saving: a refused configuration, a step without a price, a step conflict, a material without a price', async () => {
    const tenant = await freshTenant();
    const setup = await walkthrough(tenant);
    const refused = async (body: object): Promise<Refused> => {
      const response = await tenant.owner.post('/pricing/quotes', body).expect(200);
      expectDocumented(quoteResultResponseSchema, response.body);
      return response.body as Refused;
    };

    const brassGold = await refused(silverPolished(setup, { options: { material: 'brass', finish: 'gold_plated' } }));
    expect(brassGold.reasons.map((reason) => reason.code)).toEqual(['rule_requires']);

    // A step of the product's own chain that has no price.
    const engraving = (
      (await tenant.owner.post('/pricing/step-types', { key: 'engraving', name: 'Engraving', position: 60, summary_group: 'finishing' }).expect(201))
        .body as { id: string }
    ).id;
    await tenant.owner.put(`/pricing/products/${setup.productId}/steps`, { step_type_ids: [setup.steps.casting, engraving] }).expect(200);
    const unpriced = await refused(silverPolished(setup));
    expect(unpriced.reasons).toEqual([{ code: 'step_price_missing', step: 'engraving', message: expect.stringContaining('engraving') }]);

    // Silver now removes plating, which gold plating adds.
    await tenant.owner.put(`/pricing/option-values/${setup.v.silver}/step-effects`, { add: [], remove: [setup.steps.plating] }).expect(200);
    const conflict = await refused(silverPolished(setup, { options: { material: 'silver_925', finish: 'gold_plated' } }));
    expect(conflict.reasons).toEqual([{ code: 'step_conflict', step: 'plating', message: expect.stringContaining('gold_plated') }]);

    // A step's own material priced in another currency has no usable price.
    const wax = (
      (await tenant.owner
        .post('/catalog/materials', { key: 'wax', name: 'Wax', priced_unit: 'g', price_source: 'manual', manual_price: '0.01', currency: 'JPY' })
        .expect(201)).body as { id: string }
    ).id;
    await tenant.owner
      .put(`/pricing/step-types/${engraving}/prices`, {
        failure_percent: '0',
        blocks: [{ kind: 'material', source: { material_id: wax }, basis: 'piece', loss_percent: '0' }],
      })
      .expect(400);
    await tenant.owner
      .put(`/pricing/step-types/${setup.steps.casting}/prices`, {
        material_id: setup.silver,
        failure_percent: '0',
        blocks: [{ kind: 'batch', size: 8, cost_per_batch: '1', material: { source: { material_id: wax }, amount: '2', unit: 'g' } }],
      })
      .expect(200);
    await tenant.owner.put(`/pricing/step-types/${engraving}/prices`, { failure_percent: '0', blocks: [{ kind: 'fixed', amount: '4' }] }).expect(200);
    const noPrice = await refused(silverPolished(setup));
    expect(noPrice.reasons).toEqual([{ code: 'price_missing', step: 'casting', message: expect.stringContaining('wax') }]);

    expect(await quoteCount(tenant.id)).toBe(0);
  });

  it('refuses a product whose chain has no steps, without saving', async () => {
    const tenant = await freshTenant();
    const setup = await walkthrough(tenant);
    await tenant.owner.put(`/pricing/products/${setup.productId}/steps`, { step_type_ids: [] }).expect(200);

    const response = await tenant.owner.post('/pricing/quotes', silverPolished(setup)).expect(200);
    expectDocumented(quoteResultResponseSchema, response.body);
    expect((response.body as Refused).reasons.map((reason) => reason.code)).toEqual(['no_steps']);
    expect(await quoteCount(tenant.id)).toBe(0);
  });

  it('refuses a quantity that is not a whole number of pieces from 1 to 1,000,000', async () => {
    const tenant = await freshTenant();
    const setup = await walkthrough(tenant);
    for (const quantity of [0, -1, 1.5, '10', 1_000_001]) {
      const response = await tenant.owner.post('/pricing/quotes', silverPolished(setup, { quantity }));
      expect({ quantity, status: response.status }).toEqual({ quantity, status: 400 });
      expect(JSON.stringify(response.body)).toContain('quantity');
    }
    expect(await quoteCount(tenant.id)).toBe(0);
  });

  it("never prices with another workspace's product, file, group or speed", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const setupA = await walkthrough(a);
    const setupB = await walkthrough(b);

    await a.owner.post('/pricing/quotes', silverPolished(setupA, { product_id: setupB.productId })).expect(404);
    await a.owner.post('/pricing/quotes', silverPolished(setupA, { file_version_id: setupB.versionId })).expect(404);
    await b.owner.post('/pricing/customer-groups', { key: 'vip', name: 'VIP', percent: '-50' }).expect(201);
    await b.owner.post('/pricing/delivery-speeds', { key: 'same_day', name: 'Same day', surcharge_percent: '100' }).expect(201);
    for (const extra of [{ customer_group: 'vip' }, { delivery_speed: 'same_day' }, { customer_group: 'nobody' }]) {
      const response = await a.owner.post('/pricing/quotes', silverPolished(setupA, extra));
      expect({ extra, status: response.status }).toEqual({ extra, status: 400 });
      expect(JSON.stringify(response.body)).toContain(Object.keys(extra)[0]);
    }
    expect(await quoteCount(a.id)).toBe(0);

    const own = await quote(b.owner, silverPolished(setupB));
    await a.owner.get(`/pricing/quotes/${own.id}`).expect(404);
    await a.owner.get(`/pricing/quotes/${own.id}/summary`).expect(404);
    await a.owner.get(`/pricing/quotes/${newId()}`).expect(404);
  });

  it('holds the saved price when prices change, and says when it has expired', async () => {
    const tenant = await freshTenant();
    const setup = await walkthrough(tenant);
    const saved = await quote(tenant.owner, silverPolished(setup));
    const before = (await tenant.owner.get(`/pricing/quotes/${saved.id}`).expect(200)).body as Staff;
    const summaryBefore = (await tenant.owner.get(`/pricing/quotes/${saved.id}/summary`).expect(200)).body as Summary;

    await tenant.owner.put(`/catalog/materials/${setup.silver}/price-override`, { price: '0.95', reason: 'supplier' }).expect(200);
    await tenant.owner
      .put(`/pricing/step-types/${setup.steps.polishing}/prices`, { failure_percent: '0', blocks: [{ kind: 'fixed', amount: '99' }] })
      .expect(200);
    expect((await tenant.owner.get(`/pricing/quotes/${saved.id}`).expect(200)).body).toEqual(before);

    // A new quote sees the new prices.
    const fresh = await quote(tenant.owner, silverPolished(setup));
    expect(fresh.unit_price).not.toBe(saved.unit_price);

    await prisma.inTenant(tenant.id, (tx) => tx.quote.update({ where: { id: saved.id }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    const expired = (await tenant.owner.get(`/pricing/quotes/${saved.id}`).expect(200)).body as Staff;
    expect(expired).toMatchObject({ expired: true, unit_price: before.unit_price, total: before.total, breakdown: before.breakdown });
    const expiredSummary = (await tenant.owner.get(`/pricing/quotes/${saved.id}/summary`).expect(200)).body as Summary;
    expect(expiredSummary).toMatchObject({ expired: true, lines: summaryBefore.lines, unit_price: summaryBefore.unit_price });
  });

  it('lets members quote and read the summary, but not the staff breakdown', async () => {
    const tenant = await freshTenant();
    const setup = await walkthrough(tenant);

    const mine = await quote(tenant.member, silverPolished(setup));
    expect(JSON.stringify(mine)).not.toMatch(/margin|overhead|hourly|minutes|breakdown/);
    await tenant.member.get(`/pricing/quotes/${mine.id}/summary`).expect(200);
    await tenant.member.get(`/pricing/quotes/${mine.id}`).expect(403);
    await tenant.member.get('/pricing/quotes').expect(403);
  });

  it("quotes for a customer of the workspace only, with the customer's own group", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const setup = await walkthrough(a);
    const foreign = ((await b.owner.post('/customers', { name: 'Mira Studio' }).expect(201)).body as { id: string }).id;
    const luna = ((await a.owner.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;

    const plain = await quote(a.owner, silverPolished(setup));
    expect((await a.owner.get(`/pricing/quotes/${plain.id}`).expect(200)).body).toMatchObject({ customer_id: null });

    await a.owner.post('/pricing/quotes', silverPolished(setup, { customer_id: foreign })).expect(404);
    await a.owner.post('/pricing/quotes', silverPolished(setup, { customer_id: newId() })).expect(404);
    // The customer's group applies; naming one as well is a contradiction.
    await a.owner.post('/pricing/quotes', silverPolished(setup, { customer_id: luna, customer_group: 'trade' })).expect(400);
    expect(await quoteCount(a.id)).toBe(1);
  });
});
