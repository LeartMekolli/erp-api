import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { productResponseSchema } from '../src/modules/catalog/product-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Product {
  id: string;
  kind: string;
  parts: { product: { id: string; name: string }; quantity: number; size: object | null }[];
}

/**
 * Products made of parts (Orders spec, goal 6; B6; Orders 2 plan, Task 1): an assembly has no design
 * file and no sizing of its own, and lists ready-made parts, each with a number per assembly and the
 * size it is made at. One level only.
 */
describe('catalog: assemblies', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });
  const id = (response: request.Response) => (response.body as { id: string }).id;

  /**
   * Silver and brass with a material group, a finish group; a ready-made cast pendant (sizes S and M)
   * and a ready-made printed bail (no sizing), each with its own design; a custom part; and the
   * `pendant_set` assembly offering material and finish.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);

    const silver = id(
      await staff
        .post('/catalog/materials', { key: 'silver_925', name: 'Silver 925', priced_unit: 'g', price_source: 'manual', manual_price: '0.85' })
        .expect(201),
    );
    const brass = id(
      await staff.post('/catalog/materials', { key: 'brass', name: 'Brass', priced_unit: 'g', price_source: 'manual', manual_price: '0.012' }).expect(201),
    );
    const group = async (key: string) => id(await staff.post('/catalog/option-groups', { key, name: key }).expect(201));
    const value = async (groupId: string, key: string, materialId?: string) =>
      id(await staff.post(`/catalog/option-groups/${groupId}/values`, { key, name: key, material_id: materialId }).expect(201));
    const material = await group('material');
    const finish = await group('finish');
    const v = {
      silver: await value(material, 'silver_925', silver),
      brass: await value(material, 'brass', brass),
      raw: await value(finish, 'raw'),
      polished: await value(finish, 'polished'),
    };
    const options = {
      groups: [
        { group_id: material, required: true, value_ids: [v.silver, v.brass] },
        { group_id: finish, required: true, default_value_id: v.raw, value_ids: [v.raw, v.polished] },
      ],
    };

    const category = async (key: string, required_measures: string[]) =>
      id(await staff.post('/catalog/categories', { key, name: key, required_measures }).expect(201));
    const castMetal = await category('cast_metal', ['volume']);
    const assemblies = await category('assemblies', []);

    const product = async (body: object) => {
      const productId = id(await staff.post('/catalog/products', body).expect(201));
      await staff.put(`/catalog/products/${productId}/options`, options).expect(200);
      return productId;
    };
    const readyMade = async (key: string, name: string, sizing: object) => {
      const productId = await product({ category_id: castMetal, key, name, kind: 'ready_made', sizing });
      const design = (await measuredDesign(prisma, tenant.id, owner.id)).versionId;
      await staff.put(`/catalog/products/${productId}/design-file`, { file_version_id: design }).expect(200);
      return productId;
    };
    const pendant = await readyMade('pendant_part', 'Pendant', {
      mode: 'named',
      sizes: [
        { key: 'S', scale: '0.9' },
        { key: 'M', scale: '1' },
      ],
    });
    const bail = await readyMade('bail_part', 'Bail', { mode: 'none' });
    const custom = await product({ category_id: castMetal, key: 'custom_part', name: 'Custom part', kind: 'custom', sizing: { mode: 'range', min: '0.5', max: '2' } });

    const created = await staff.post('/catalog/products', { category_id: assemblies, key: 'pendant_set', name: 'Pendant set', kind: 'assembly' }).expect(201);
    const set = id(created);
    await staff.put(`/catalog/products/${set}/options`, options).expect(200);

    return { id: tenant.id, ownerId: owner.id, staff, assemblies, castMetal, pendant, bail, custom, set, created };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;
  const parts = (tenant: Tenant, body: object[]) => tenant.staff.put(`/catalog/products/${tenant.set}/parts`, { parts: body });
  const goodParts = (tenant: Tenant) => [
    { product_id: tenant.pendant, quantity: 1, size: { named: 'M' } },
    { product_id: tenant.bail, quantity: 2 },
  ];

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

  it('creates an assembly with no sizing, no design file and no parts yet', async () => {
    const tenant = await freshTenant();
    expectDocumented(productResponseSchema, tenant.created.body);
    expect(tenant.created.body).toMatchObject({ kind: 'assembly', sizing: { mode: 'none' }, design_file: null, parts: [] });

    // Its size comes from its parts; its design files too.
    const base = { category_id: tenant.assemblies, name: 'Other set', kind: 'assembly' };
    await tenant.staff.post('/catalog/products', { ...base, key: 'ranged_set', sizing: { mode: 'range', min: '0.5', max: '2' } }).expect(400);
    const design = (await measuredDesign(prisma, tenant.id, tenant.ownerId)).versionId;
    await tenant.staff.put(`/catalog/products/${tenant.set}/design-file`, { file_version_id: design }).expect(409);
    // Every other product lists no parts.
    expect(((await tenant.staff.get(`/catalog/products/${tenant.pendant}`).expect(200)).body as Product).parts).toEqual([]);
  });

  it('lists its parts, each with a number per assembly and the size it is made at', async () => {
    const tenant = await freshTenant();

    const set = await parts(tenant, goodParts(tenant)).expect(200);
    expectDocumented(productResponseSchema, set.body);
    expect((set.body as Product).parts).toEqual([
      { product: { id: tenant.pendant, name: 'Pendant' }, quantity: 1, size: { named: 'M' } },
      { product: { id: tenant.bail, name: 'Bail' }, quantity: 2, size: null },
    ]);
    expect((await tenant.staff.get(`/catalog/products/${tenant.set}`).expect(200)).body).toEqual(set.body);

    // Sent again, the list is replaced.
    const replaced = await parts(tenant, [{ product_id: tenant.bail, quantity: 3 }]).expect(200);
    expect((replaced.body as Product).parts).toEqual([{ product: { id: tenant.bail, name: 'Bail' }, quantity: 3, size: null }]);
  });

  it('refuses parts that are not ready-made, fit no size, or make a second level', async () => {
    const tenant = await freshTenant();
    const other = id(
      await tenant.staff.post('/catalog/products', { category_id: tenant.assemblies, key: 'other_set', name: 'Other set', kind: 'assembly' }).expect(201),
    );
    const customer = id(await tenant.staff.post('/customers', { name: 'Luna Jewels' }).expect(201));
    const privatePart = id(
      await tenant.staff
        .post('/catalog/products', { category_id: tenant.castMetal, key: 'luna_part', name: 'Luna part', kind: 'ready_made', customer_id: customer })
        .expect(201),
    );

    for (const body of [
      [{ product_id: tenant.custom, quantity: 1 }],
      [{ product_id: other, quantity: 1 }],
      [{ product_id: tenant.set, quantity: 1 }],
      [{ product_id: privatePart, quantity: 1 }],
      [{ product_id: tenant.pendant, quantity: 1, size: { named: 'L' } }],
      [{ product_id: tenant.pendant, quantity: 1, size: { scale: '1' } }],
      [{ product_id: tenant.bail, quantity: 1, size: { named: 'M' } }],
      [{ product_id: tenant.bail, quantity: 0 }],
      [{ product_id: tenant.bail, quantity: 101 }],
      [
        { product_id: tenant.bail, quantity: 1 },
        { product_id: tenant.bail, quantity: 2 },
      ],
      Array.from({ length: 21 }, () => ({ product_id: tenant.bail, quantity: 1 })),
      [],
    ]) {
      const response = await parts(tenant, body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    // A part that isn't there, or isn't this workspace's, is not found.
    await parts(tenant, [{ product_id: newId(), quantity: 1 }]).expect(404);
    const elsewhere = await freshTenant();
    await parts(tenant, [{ product_id: elsewhere.bail, quantity: 1 }]).expect(404);
    // Only an assembly has parts.
    await tenant.staff.put(`/catalog/products/${tenant.pendant}/parts`, { parts: [{ product_id: tenant.bail, quantity: 1 }] }).expect(400);
    expect(((await tenant.staff.get(`/catalog/products/${tenant.set}`).expect(200)).body as Product).parts).toEqual([]);
  });

  it('checks an assembly by its options alone', async () => {
    const tenant = await freshTenant();
    await parts(tenant, goodParts(tenant)).expect(200);

    const checked = await tenant.staff.post(`/catalog/products/${tenant.set}/check`, { options: { material: 'silver_925', finish: 'polished' } }).expect(200);
    expect(checked.body).toMatchObject({ accepted: true, scale: '1', measures: [], material: { key: 'silver_925' } });
    const design = (await measuredDesign(prisma, tenant.id, tenant.ownerId)).versionId;
    await tenant.staff.post(`/catalog/products/${tenant.set}/check`, { options: { material: 'silver_925' }, file_version_id: design }).expect(400);
  });
});
