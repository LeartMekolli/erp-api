import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { portalProductSchema } from '../src/modules/customers/customer-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

const PASSWORD = 'a-long-customer-password';

interface Summary {
  id: string;
  unit_price: string;
}
interface PortalProduct {
  id: string;
  name: string;
}

type Client = ReturnType<typeof clientFor>;

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return {
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
  };
}

describe("portal: save a quote as the customer's own product", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_NOTIFIER)
      .useValue(notifier)
      .compile();
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

  /**
   * The priced cast part, published, with its own chain (casting, then polishing) and its own 50 %
   * margin, so a saved product that failed to copy either would price differently. Luna (group
   * trade): Anna owns it, Ben is a buyer. Sol: Sam owns it, Ben is a viewer. Each has its own design.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const staffUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, staffUser.id)).accessToken);
    const setup = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: staffUser.id, runMetal });
    await staff.patch(`/catalog/products/${setup.productId}`, { published: true }).expect(200);
    await staff.put(`/pricing/products/${setup.productId}/steps`, { step_type_ids: [setup.steps.casting, setup.steps.polishing] }).expect(200);
    await staff.put(`/pricing/products/${setup.productId}/margin`, { margin_percent: '50' }).expect(200);

    const id = (response: request.Response) => (response.body as { id: string }).id;
    const luna = id(await staff.post('/customers', { name: 'Luna Jewels', customer_group_id: setup.tradeGroupId }).expect(201));
    const sol = id(await staff.post('/customers', { name: 'Sol Rings' }).expect(201));

    async function join(customerId: string, email: string, role: string, name?: string) {
      await staff.post(`/customers/${customerId}/invitations`, { email, role }).expect(201);
      const token = notifier.lastCustomerInvitationFor(email)!.token;
      await request(app.getHttpServer())
        .post('/auth/customer-invitations/accept')
        .send(name ? { token, name, password: PASSWORD } : { token })
        .expect(204);
    }
    const person = async (email: string) => {
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      return { id: user.id, client: clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken) };
    };
    const emails = { anna: `anna-${newId()}@portal.example.test`, ben: `ben-${newId()}@portal.example.test`, sam: `sam-${newId()}@portal.example.test` };
    await join(luna, emails.anna, 'owner', 'Anna');
    await join(luna, emails.ben, 'buyer', 'Ben');
    await join(sol, emails.sam, 'owner', 'Sam');
    await join(sol, emails.ben, 'viewer');
    const ben = await person(emails.ben);
    const sam = await person(emails.sam);

    return {
      staff,
      setup,
      luna,
      sol,
      anna: (await person(emails.anna)).client,
      ben: ben.client,
      sam: sam.client,
      lunaVersion: (await measuredDesign(prisma, tenant.id, ben.id, { customerId: luna })).versionId,
      solVersion: (await measuredDesign(prisma, tenant.id, sam.id, { customerId: sol })).versionId,
    };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const portal = (customerId: string, rest: string) => `/portal/customers/${customerId}${rest}`;
  const choice = { options: { material: 'silver_925', finish: 'polished' }, size: { scale: '1.5' }, quantity: 1 };

  async function quote(client: Client, customerId: string, body: object): Promise<Summary> {
    const response = await client.post(portal(customerId, '/quotes'), body).expect(201);
    return (response.body as { quote: Summary }).quote;
  }
  const lunaQuote = (w: Workspace) => quote(w.ben, w.luna, { ...choice, product_id: w.setup.productId, file_version_id: w.lunaVersion });
  const catalog = async (client: Client, customerId: string) =>
    ((await client.get(portal(customerId, '/products')).expect(200)).body as { data: PortalProduct[] }).data.map((product) => product.name);

  it('saves a quote as a private product with the design pinned, which then quotes at current prices', async () => {
    const w = await workspace();
    const original = await lunaQuote(w);

    const saved = await w.ben.post(portal(w.luna, '/products'), { quote_id: original.id, name: 'Luna Moon Ring' }).expect(201);
    expectDocumented(portalProductSchema, saved.body);
    expect(saved.body).toEqual({
      id: expect.any(String),
      name: 'Luna Moon Ring',
      kind: 'ready_made',
      private: true,
      sizing: { mode: 'range', min: '0.5', max: '2' },
      options: [
        {
          key: 'material',
          name: 'material',
          required: true,
          default: null,
          values: [
            { key: 'silver_925', name: 'silver_925' },
            { key: 'brass', name: 'brass' },
          ],
        },
        {
          key: 'finish',
          name: 'finish',
          required: true,
          default: 'raw',
          values: [
            { key: 'raw', name: 'raw' },
            { key: 'polished', name: 'polished' },
            { key: 'gold_plated', name: 'gold_plated' },
          ],
        },
      ],
      design_file: { version_id: w.lunaVersion },
      parts: [],
    });
    const productId = (saved.body as PortalProduct).id;
    expect(await catalog(w.anna, w.luna)).toEqual(['Custom cast part', 'Luna Moon Ring']);

    const staffView = await w.staff.get(`/catalog/products/${productId}`).expect(200);
    expect(staffView.body).toMatchObject({ customer_id: w.luna, published: true, category_id: w.setup.categoryId });
    expect((staffView.body as { key: string }).key).toMatch(/^custom_cast_part_[a-z0-9]{6}$/);

    // Its own design, so only options and size: the same price, through the copied chain and margin.
    const again = await quote(w.anna, w.luna, { ...choice, product_id: productId });
    expect(again.unit_price).toBe(original.unit_price);

    // Prices move; the saved product follows them, the saved quote does not.
    await w.staff.put(`/catalog/materials/${w.setup.silver}/price-override`, { price: '0.95', reason: 'supplier' }).expect(200);
    const later = await quote(w.anna, w.luna, { ...choice, product_id: productId });
    expect(Number(later.unit_price)).toBeGreaterThan(Number(original.unit_price));
    expect((await w.anna.get(portal(w.luna, `/quotes/${original.id}`)).expect(200)).body).toMatchObject({
      unit_price: original.unit_price,
    });
  });

  it("keeps the saved product to its customer, and refuses quotes it can't be made from", async () => {
    const w = await workspace();
    const original = await lunaQuote(w);
    const saved = (await w.ben.post(portal(w.luna, '/products'), { quote_id: original.id, name: 'Luna Moon Ring' }).expect(201))
      .body as PortalProduct;

    // Sol neither sees nor quotes it.
    expect(await catalog(w.sam, w.sol)).toEqual(['Custom cast part']);
    await w.sam.post(portal(w.sol, '/quotes'), { ...choice, product_id: saved.id }).expect(404);

    // Sol's quote under Luna, an unknown quote, a quote of a ready-made product, a viewer, a bad name.
    const solQuote = await quote(w.sam, w.sol, { ...choice, product_id: w.setup.productId, file_version_id: w.solVersion });
    await w.anna.post(portal(w.luna, '/products'), { quote_id: solQuote.id, name: 'Borrowed' }).expect(404);
    await w.anna.post(portal(w.luna, '/products'), { quote_id: newId(), name: 'Nothing' }).expect(404);
    const readyMadeQuote = await quote(w.anna, w.luna, { ...choice, product_id: saved.id });
    await w.anna.post(portal(w.luna, '/products'), { quote_id: readyMadeQuote.id, name: 'Twice saved' }).expect(400);
    await w.ben.post(portal(w.sol, '/products'), { quote_id: solQuote.id, name: 'Viewer' }).expect(403);
    await w.anna.post(portal(w.luna, '/products'), { quote_id: original.id, name: ' ' }).expect(400);

    // Staff can hide it.
    await w.staff.patch(`/catalog/products/${saved.id}`, { published: false }).expect(200);
    expect(await catalog(w.anna, w.luna)).toEqual(['Custom cast part']);
  });
});
