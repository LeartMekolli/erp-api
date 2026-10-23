import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { categoryResponseSchema, productResponseSchema } from '../src/modules/catalog/product-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { measuredDesign } from './catalog-fixtures';

interface Product {
  id: string;
  options: { group_id: string; required: boolean; default_value_id: string | null; value_ids: string[] }[];
  design_file: { file_id: string; version_id: string } | null;
}

describe('catalog: categories and products', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const as = (token: string) => ({
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
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

  /** A category, a material and a finish group with three values. */
  async function setup(tenant: Tenant) {
    const category = (
      await tenant.owner
        .post('/catalog/categories', { key: 'cast_metal', name: 'Cast metal parts', required_measures: ['volume', 'bounding_box_x'] })
        .expect(201)
    ).body as { id: string };
    const group = (await tenant.owner.post('/catalog/option-groups', { key: 'finish', name: 'Finish' }).expect(201)).body as {
      id: string;
    };
    const value = async (key: string) =>
      ((await tenant.owner.post(`/catalog/option-groups/${group.id}/values`, { key, name: key }).expect(201)).body as {
        id: string;
      }).id;
    return { categoryId: category.id, groupId: group.id, raw: await value('raw'), polished: await value('polished') };
  }

  const customCastPart = (categoryId: string) => ({
    category_id: categoryId,
    key: 'custom_cast_part',
    name: 'Custom cast part',
    kind: 'custom',
    sizing: { mode: 'range', min: '0.5', max: '2' },
  });
  const ringModel = (categoryId: string) => ({
    category_id: categoryId,
    key: 'ring_model_12',
    name: 'Ring model 12',
    kind: 'ready_made',
    sizing: {
      mode: 'named',
      sizes: [
        { key: 'S', scale: '0.9' },
        { key: 'M', scale: '1' },
        { key: 'L', scale: '1.1' },
      ],
    },
  });

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

  it('creates categories and both kinds of product, and lists them', async () => {
    const tenant = await freshTenant();
    const { categoryId } = await setup(tenant);

    const categories = await tenant.member.get('/catalog/categories').expect(200);
    expect((categories.body as { data: unknown[] }).data).toHaveLength(1);
    expectDocumented(categoryResponseSchema, (categories.body as { data: unknown[] }).data[0]);

    const custom = await tenant.owner.post('/catalog/products', customCastPart(categoryId)).expect(201);
    expectDocumented(productResponseSchema, custom.body);
    // New products are hidden from customers and shared, until staff say otherwise.
    expect(custom.body).toMatchObject({
      kind: 'custom',
      sizing: { mode: 'range', min: '0.5', max: '2' },
      design_file: null,
      published: false,
      customer_id: null,
    });
    await tenant.owner.post('/catalog/products', ringModel(categoryId)).expect(201);

    const listed = await tenant.member.get('/catalog/products').expect(200);
    expectDocumented(pageSchema(productResponseSchema), listed.body);
    expect((listed.body as { data: unknown[] }).data).toHaveLength(2);

    const renamed = await tenant.owner.patch(`/catalog/products/${(custom.body as Product).id}`, { name: 'Cast part' }).expect(200);
    expect(renamed.body).toMatchObject({ name: 'Cast part' });
  });

  it('refuses bad categories, products and sizing', async () => {
    const tenant = await freshTenant();
    const { categoryId } = await setup(tenant);

    await tenant.owner.post('/catalog/categories', { key: 'x', name: 'x', required_measures: ['weight'] }).expect(400);
    await tenant.owner.post('/catalog/categories', { key: 'cast_metal', name: 'Again', required_measures: [] }).expect(409);

    const bad = [
      { ...customCastPart(categoryId), kind: 'bundle' },
      { ...customCastPart(categoryId), sizing: { mode: 'range', min: '2', max: '0.5' } },
      { ...customCastPart(categoryId), sizing: { mode: 'range', min: '0', max: '2' } },
      { ...customCastPart(categoryId), sizing: { mode: 'range', min: '1e1', max: '2' } },
      { ...customCastPart(categoryId), sizing: { mode: 'named', sizes: [] } },
      { ...customCastPart(categoryId), sizing: { mode: 'named', sizes: [{ key: 'S', scale: '1' }, { key: 'S', scale: '2' }] } },
    ];
    for (const body of bad) {
      const response = await tenant.owner.post('/catalog/products', body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    await tenant.owner.post('/catalog/products', { ...customCastPart(categoryId), category_id: newId() }).expect(404);
    await tenant.owner.post('/catalog/products', customCastPart(categoryId)).expect(201);
    await tenant.owner.post('/catalog/products', customCastPart(categoryId)).expect(409);
    await tenant.member.post('/catalog/products', { ...customCastPart(categoryId), key: 'other' }).expect(403);
  });

  it('sets the options a product offers, with defaults', async () => {
    const tenant = await freshTenant();
    const ids = await setup(tenant);
    const product = (await tenant.owner.post('/catalog/products', customCastPart(ids.categoryId)).expect(201)).body as Product;

    const set = await tenant.owner
      .put(`/catalog/products/${product.id}/options`, {
        groups: [{ group_id: ids.groupId, required: true, default_value_id: ids.raw, value_ids: [ids.raw, ids.polished] }],
      })
      .expect(200);
    expectDocumented(productResponseSchema, set.body);
    expect((set.body as Product).options).toEqual([
      expect.objectContaining({ group_id: ids.groupId, required: true, default_value_id: ids.raw }),
    ]);
    expect([...(set.body as Product).options[0].value_ids].sort()).toEqual([ids.raw, ids.polished].sort());

    // A default the product does not offer, and a value from another group, are refused.
    await tenant.owner
      .put(`/catalog/products/${product.id}/options`, {
        groups: [{ group_id: ids.groupId, required: true, default_value_id: ids.polished, value_ids: [ids.raw] }],
      })
      .expect(400);
    const other = (await tenant.owner.post('/catalog/option-groups', { key: 'material', name: 'Material' }).expect(201)).body as {
      id: string;
    };
    await tenant.owner
      .put(`/catalog/products/${product.id}/options`, { groups: [{ group_id: other.id, required: false, value_ids: [ids.raw] }] })
      .expect(400);

    // Replacing with nothing clears the options.
    const cleared = await tenant.owner.put(`/catalog/products/${product.id}/options`, { groups: [] }).expect(200);
    expect((cleared.body as Product).options).toEqual([]);
  });

  it('attaches a measured design file to a ready-made product only', async () => {
    const tenant = await freshTenant();
    const { categoryId } = await setup(tenant);
    const ring = (await tenant.owner.post('/catalog/products', ringModel(categoryId)).expect(201)).body as Product;
    const custom = (await tenant.owner.post('/catalog/products', customCastPart(categoryId)).expect(201)).body as Product;
    const attach = (productId: string, versionId: string) =>
      tenant.owner.put(`/catalog/products/${productId}/design-file`, { file_version_id: versionId });

    const pending = await measuredDesign(prisma, tenant.id, tenant.ownerId, { status: 'uploaded', measures: [] });
    await attach(ring.id, pending.versionId).expect(409);

    const noVolume = await measuredDesign(prisma, tenant.id, tenant.ownerId, { measures: [['bounding_box_x', '10', 'mm']] });
    const refused = await attach(ring.id, noVolume.versionId).expect(409);
    expect((refused.body as { detail: string }).detail).toMatch(/volume/);

    const good = await measuredDesign(prisma, tenant.id, tenant.ownerId);
    await attach(custom.id, good.versionId).expect(409);
    const attached = await attach(ring.id, good.versionId).expect(200);
    expectDocumented(productResponseSchema, attached.body);
    expect((attached.body as Product).design_file).toEqual({ file_id: good.fileId, version_id: good.versionId });
  });

  it('keeps every reference inside the tenant', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const idsA = await setup(a);
    const idsB = await setup(b);
    const ringA = (await a.owner.post('/catalog/products', ringModel(idsA.categoryId)).expect(201)).body as Product;
    const versionB = await measuredDesign(prisma, b.id, b.ownerId);

    await a.owner.post('/catalog/products', customCastPart(idsB.categoryId)).expect(404);
    await a.owner.put(`/catalog/products/${ringA.id}/design-file`, { file_version_id: versionB.versionId }).expect(404);
    await a.owner
      .put(`/catalog/products/${ringA.id}/options`, { groups: [{ group_id: idsB.groupId, required: false, value_ids: [idsB.raw] }] })
      .expect(404);
    await b.owner.get(`/catalog/products/${ringA.id}`).expect(404);
  });

  it('publishes a product to customers, and makes one private to a customer of the workspace only', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const { categoryId } = await setup(a);
    const customerOf = async (tenant: Tenant, name: string) =>
      ((await tenant.owner.post('/customers', { name }).expect(201)).body as { id: string }).id;
    const luna = await customerOf(a, 'Luna Jewels');
    const foreign = await customerOf(b, 'Mira Studio');

    const created = await a.owner
      .post('/catalog/products', { ...customCastPart(categoryId), key: 'luna_signet', published: true, customer_id: luna })
      .expect(201);
    expectDocumented(productResponseSchema, created.body);
    expect(created.body).toMatchObject({ published: true, customer_id: luna });
    const id = (created.body as Product).id;

    const shared = await a.owner.patch(`/catalog/products/${id}`, { published: false, customer_id: null }).expect(200);
    expect(shared.body).toMatchObject({ published: false, customer_id: null });

    // Another workspace's customer, or none at all, is not found.
    await a.owner.post('/catalog/products', { ...customCastPart(categoryId), key: 'x', customer_id: foreign }).expect(404);
    await a.owner.patch(`/catalog/products/${id}`, { customer_id: foreign }).expect(404);
    await a.owner.patch(`/catalog/products/${id}`, { customer_id: newId() }).expect(404);
    await a.owner.patch(`/catalog/products/${id}`, { published: 'yes' }).expect(400);
  });
});
