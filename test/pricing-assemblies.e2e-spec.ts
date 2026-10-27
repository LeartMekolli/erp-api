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
import { quoteResponseSchema, quoteSummaryResponseSchema } from '../src/modules/pricing/quote-response';
import { QuotesService } from '../src/modules/pricing/quotes.service';
import { pricedAssembly } from './assembly-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Part {
  position: number;
  product: { id: string; name: string };
  quantity: number;
  quote_id: string;
  unit_price: string;
  total: string;
}
interface StaffQuote {
  id: string;
  product_id: string;
  quantity: number;
  unit_price: string;
  total: string;
  inputs: { options: Record<string, string>; size: object | null };
  materials: { key: string }[];
  breakdown: { unit_price: string; total: string; parts: Part[] };
}
interface Summary {
  id: string;
  unit_price: string;
  total: string;
  lines: { label: string; amount: string }[];
}

/**
 * Pricing a product made of parts (Orders spec, goal 6; B4; Orders 2 plan, Task 2): one quote for the
 * set, over one quote per part. The customer sees one price per line; staff see the parts.
 */
describe('pricing: assemblies', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let quotes: QuotesService;
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
  const money = (value: Prisma.Decimal | string) => new Prisma.Decimal(value).toFixed(2);

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const set = await pricedAssembly(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const user = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind: 'customer' } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'customer', organisationId: luna, role: 'buyer' } });
    });
    const ben = as((await tokens.issueForUser(tenant.id, user.id)).accessToken);
    return { id: tenant.id, userId: owner.id, staff, ben, luna, ...set };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const configuration = (tenant: Tenant, extra: object = {}) => ({
    product_id: tenant.set,
    options: { material: 'silver_925', finish: 'polished' },
    quantity: 3,
    ...extra,
  });
  /** Staff quote the set for Luna and read the staff view. */
  const staffQuote = async (tenant: Tenant, extra: object = {}) => {
    const created = await tenant.staff.post('/pricing/quotes', { ...configuration(tenant, extra), customer_id: tenant.luna }).expect(201);
    return read(tenant, (created.body as { quote: { id: string } }).quote.id);
  };
  const read = async (tenant: Tenant, id: string) => (await tenant.staff.get(`/pricing/quotes/${id}`).expect(200)).body as StaffQuote;
  const quoteCount = (tenant: Tenant) => prisma.inTenant(tenant.id, (tx) => tx.quote.count());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    quotes = moduleRef.get(QuotesService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('prices a set as its own steps plus a quote per part, at the quantity each part is needed', async () => {
    const tenant = await freshTenant();

    const quote = await staffQuote(tenant);
    expectDocumented(quoteResponseSchema, quote);
    const [pendant, bail] = quote.breakdown.parts;
    expect(quote.breakdown.parts.map((part) => [part.position, part.product, part.quantity])).toEqual([
      [0, { id: tenant.pendant, name: 'Pendant' }, 3],
      [1, { id: tenant.bail, name: 'Bail' }, 6],
    ]);

    // One set is its own price plus one pendant and two bails; the line, that times three.
    expect(quote.unit_price).toBe(
      money(new Prisma.Decimal(quote.breakdown.unit_price).plus(pendant.unit_price).plus(new Prisma.Decimal(bail.unit_price).times(2))),
    );
    expect(quote.total).toBe(money(new Prisma.Decimal(quote.breakdown.total).plus(pendant.total).plus(bail.total)));
    expect(quote.total).toBe(money(new Prisma.Decimal(quote.unit_price).times(3)));

    // Each part is its own quote: the set's options where the part offers them, the part's size, its quantity.
    const pendantQuote = await read(tenant, pendant.quote_id);
    expect(pendantQuote).toMatchObject({
      product_id: tenant.pendant,
      quantity: 3,
      total: pendant.total,
      inputs: { options: { material: 'silver_925', finish: 'polished' }, size: { named: 'M' } },
    });
    expect(pendantQuote.materials.map((material) => material.key)).toContain('silver_925');
    const bailQuote = await read(tenant, bail.quote_id);
    expect(bailQuote).toMatchObject({ product_id: tenant.bail, quantity: 6, total: bail.total, inputs: { options: {}, size: null } });
    expect(bailQuote.materials.map((material) => material.key)).toEqual(['pattern_resin']);

    // Staff list the set's quote, not its parts'.
    const listed = (await tenant.staff.get('/pricing/quotes').expect(200)).body as { data: { id: string }[] };
    expect(listed.data.map((row) => row.id)).toEqual([quote.id]);
  });

  it('shows the customer one price for the set, never its parts', async () => {
    const tenant = await freshTenant();
    const portal = `/portal/customers/${tenant.luna}/quotes`;

    const created = await tenant.ben.post(portal, configuration(tenant)).expect(201);
    const summary = (created.body as { quote: Summary }).quote;
    expectDocumented(quoteSummaryResponseSchema, summary);
    const sum = summary.lines.reduce((total, line) => total.plus(line.amount), new Prisma.Decimal(0));
    expect(money(sum)).toBe(summary.unit_price);

    const staffView = await read(tenant, summary.id);
    expect(summary.total).toBe(staffView.total);
    const seen = [created.text, (await tenant.ben.get(portal).expect(200)).text, (await tenant.ben.get(`${portal}/${summary.id}`).expect(200)).text].join('\n');
    for (const secret of ['parts', 'cost', 'margin', ...staffView.breakdown.parts.map((part) => part.quote_id)]) {
      expect({ secret, found: seen.includes(secret) }).toEqual({ secret, found: false });
    }
    // A part's quote is not the customer's to read.
    await tenant.ben.get(`${portal}/${staffView.breakdown.parts[0].quote_id}`).expect(404);
  });

  it('refuses the whole set when a part cannot be priced, and saves nothing', async () => {
    const tenant = await freshTenant();
    // A pendant only offered in brass, in a set offered in silver too.
    const brassOnly = ((await tenant.staff.post('/catalog/products', {
      category_id: tenant.cast.categoryId,
      key: 'brass_pendant',
      name: 'Brass pendant',
      kind: 'ready_made',
    }).expect(201)).body as { id: string }).id;
    const [material, finish] = tenant.options.groups;
    await tenant.staff
      .put(`/catalog/products/${brassOnly}/options`, { groups: [{ ...material, value_ids: [tenant.cast.v.brass] }, finish] })
      .expect(200);
    await tenant.staff.put(`/catalog/products/${brassOnly}/design-file`, { file_version_id: tenant.cast.versionId }).expect(200);
    const brassSet = ((await tenant.staff.post('/catalog/products', {
      category_id: tenant.assemblies,
      key: 'brass_set',
      name: 'Brass set',
      kind: 'assembly',
    }).expect(201)).body as { id: string }).id;
    await tenant.staff.put(`/catalog/products/${brassSet}/options`, tenant.options).expect(200);
    await tenant.staff.put(`/catalog/products/${brassSet}/parts`, { parts: [{ product_id: brassOnly, quantity: 1 }] }).expect(200);
    const before = await quoteCount(tenant);

    const refused = await tenant.staff.post('/pricing/quotes', { ...configuration(tenant), product_id: brassSet }).expect(200);
    const reasons = (refused.body as { accepted: boolean; reasons: { part?: number; message: string }[] }).reasons;
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((reason) => reason.part === 0 && reason.message.startsWith('Part Brass pendant: '))).toBe(true);
    expect(await quoteCount(tenant)).toBe(before);
    // In brass, the same set prices.
    await tenant.staff.post('/pricing/quotes', { ...configuration(tenant, { options: { material: 'brass', finish: 'polished' } }), product_id: brassSet }).expect(201);
  });

  it('never lets the customer pick a workshop for a set', async () => {
    const tenant = await freshTenant();
    await tenant.staff.patch(`/customers/${tenant.luna}`, { may_pick_partner: true }).expect(200);
    const portal = `/portal/customers/${tenant.luna}/quotes`;

    await tenant.ben.post(portal, configuration(tenant, { partner_id: newId() })).expect(400);
    await tenant.ben.post(`${portal}/partners`, configuration(tenant)).expect(400);
  });

  it('prices a set again whole, parts and all, at current prices', async () => {
    const tenant = await freshTenant();
    const first = await staffQuote(tenant);
    await tenant.setChainPrice('5.00');

    const again = await quotes.requote({ tenantId: tenant.id, userId: tenant.userId }, first.id);
    if (!again.accepted) throw new Error(`refused: ${JSON.stringify(again.reasons)}`);
    const second = await read(tenant, again.quote.id);
    expect(second.id).not.toBe(first.id);
    expect(new Prisma.Decimal(second.total).greaterThan(first.total)).toBe(true);
    expect(second.breakdown.parts.map((part) => part.quantity)).toEqual([3, 6]);
    expect(second.breakdown.parts.map((part) => part.quote_id)).not.toEqual(first.breakdown.parts.map((part) => part.quote_id));
    // Only a set is priced again as a whole; its parts are never ordered alone.
    await expect(quotes.requote({ tenantId: tenant.id, userId: tenant.userId }, first.breakdown.parts[0].quote_id)).rejects.toThrow();
  });
});
