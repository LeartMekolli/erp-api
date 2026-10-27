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

const PASSWORD = 'a-long-customer-password';

interface PortalProduct {
  id: string;
  name: string;
}

describe('portal: what customers see of the catalog', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
  });

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
   * Luna (Anna) and Sol (Sam) in one workspace, whose catalog has: a published
   * custom cast part with material and finish options, a published ring with
   * its design file, an unpublished internal part, Luna's published private
   * signet and Luna's unpublished private draft.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const staffUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, staffUser.id)).accessToken);
    const id = (response: request.Response) => (response.body as { id: string }).id;

    async function customerPerson(customerName: string, personName: string) {
      const customerId = id(await staff.post('/customers', { name: customerName }).expect(201));
      const email = `${personName.toLowerCase()}-${newId()}@portal.example.test`;
      await staff.post(`/customers/${customerId}/invitations`, { email, role: 'owner' }).expect(201);
      const token = notifier.lastCustomerInvitationFor(email)!.token;
      await http().post('/auth/customer-invitations/accept').send({ token, name: personName, password: PASSWORD }).expect(204);
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      return { customerId, client: as((await tokens.issueForUser(tenant.id, user.id)).accessToken) };
    }
    const luna = await customerPerson('Luna Jewels', 'Anna');
    const sol = await customerPerson('Sol Rings', 'Sam');

    const category = id(
      await staff.post('/catalog/categories', { key: 'cast_metal', name: 'Cast metal parts', required_measures: ['volume'] }).expect(201),
    );
    const brass = id(
      await staff
        .post('/catalog/materials', { key: 'brass', name: 'Brass', priced_unit: 'g', price_source: 'manual', manual_price: '0.012' })
        .expect(201),
    );
    const group = async (key: string, name: string) => id(await staff.post('/catalog/option-groups', { key, name }).expect(201));
    const value = async (groupId: string, key: string, name: string, materialId?: string) =>
      id(await staff.post(`/catalog/option-groups/${groupId}/values`, { key, name, material_id: materialId }).expect(201));
    const materialGroup = await group('material', 'Material');
    const finishGroup = await group('finish', 'Finish');
    const brassValue = await value(materialGroup, 'brass', 'Brass', brass);
    const raw = await value(finishGroup, 'raw', 'Raw');
    const polished = await value(finishGroup, 'polished', 'Polished');

    const product = async (body: object) =>
      id(
        await staff
          .post('/catalog/products', { category_id: category, kind: 'custom', sizing: { mode: 'range', min: '0.5', max: '2' }, ...body })
          .expect(201),
      );
    const castPart = await product({ key: 'custom_cast_part', name: 'Custom cast part', published: true });
    await staff
      .put(`/catalog/products/${castPart}/options`, {
        groups: [
          { group_id: materialGroup, required: true, default_value_id: brassValue, value_ids: [brassValue] },
          { group_id: finishGroup, required: false, value_ids: [raw, polished] },
        ],
      })
      .expect(200);
    const ring = await product({
      key: 'ring_model_12',
      name: 'Ring model 12',
      kind: 'ready_made',
      material_id: brass,
      sizing: { mode: 'named', sizes: [{ key: 'M', scale: '1' }] },
      published: true,
    });
    const design = await measuredDesign(prisma, tenant.id, staffUser.id);
    await staff.put(`/catalog/products/${ring}/design-file`, { file_version_id: design.versionId }).expect(200);
    await product({ key: 'internal_part', name: 'Internal part' });
    const signet = await product({ key: 'luna_signet', name: 'Luna signet', published: true, customer_id: luna.customerId });
    await product({ key: 'luna_draft', name: 'Luna draft', customer_id: luna.customerId });

    return { staff, luna, sol, castPart, ring, signet, designVersionId: design.versionId };
  }

  const products = async (client: ReturnType<typeof as>, customerId: string): Promise<PortalProduct[]> => {
    const response = await client.get(`/portal/customers/${customerId}/products`).expect(200);
    const data = (response.body as { data: PortalProduct[] }).data;
    data.forEach((product) => expectDocumented(portalProductSchema, product));
    return data;
  };

  it("shows published shared products and the customer's own published products, by name", async () => {
    const w = await workspace();

    expect((await products(w.luna.client, w.luna.customerId)).map((product) => product.name)).toEqual([
      'Custom cast part',
      'Luna signet',
      'Ring model 12',
    ]);
    expect((await products(w.sol.client, w.sol.customerId)).map((product) => product.name)).toEqual([
      'Custom cast part',
      'Ring model 12',
    ]);
  });

  it('describes products by keys and names, never by prices or internal ids', async () => {
    const w = await workspace();

    const response = await w.luna.client.get(`/portal/customers/${w.luna.customerId}/products`).expect(200);
    const byName = new Map((response.body as { data: (PortalProduct & object)[] }).data.map((product) => [product.name, product]));

    expect(byName.get('Custom cast part')).toEqual({
      id: w.castPart,
      name: 'Custom cast part',
      kind: 'custom',
      private: false,
      sizing: { mode: 'range', min: '0.5', max: '2' },
      options: [
        { key: 'material', name: 'Material', required: true, default: 'brass', values: [{ key: 'brass', name: 'Brass' }] },
        {
          key: 'finish',
          name: 'Finish',
          required: false,
          default: null,
          values: [
            { key: 'raw', name: 'Raw' },
            { key: 'polished', name: 'Polished' },
          ],
        },
      ],
      design_file: null,
      parts: [],
    });
    expect(byName.get('Ring model 12')).toMatchObject({ kind: 'ready_made', design_file: { version_id: w.designVersionId } });
    expect(byName.get('Luna signet')).toMatchObject({ id: w.signet, private: true });

    // Checked on the raw body: nothing about materials, prices or pricing setup.
    expect(JSON.stringify(response.body)).not.toMatch(/material_id|price|density|margin|step|customer_id|published/);
  });

  it('hides a product at once when staff unpublish it', async () => {
    const w = await workspace();

    await w.staff.patch(`/catalog/products/${w.castPart}`, { published: false }).expect(200);
    await w.staff.patch(`/catalog/products/${w.signet}`, { customer_id: w.sol.customerId }).expect(200);

    expect((await products(w.luna.client, w.luna.customerId)).map((product) => product.name)).toEqual(['Ring model 12']);
    expect((await products(w.sol.client, w.sol.customerId)).map((product) => product.name)).toEqual([
      'Luna signet',
      'Ring model 12',
    ]);
  });

  it("keeps the portal catalog to the customer's own people", async () => {
    const w = await workspace();

    await w.sol.client.get(`/portal/customers/${w.luna.customerId}/products`).expect(404);
    await w.staff.get(`/portal/customers/${w.luna.customerId}/products`).expect(403);
  });
});
