import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { checkResponseSchema } from '../src/modules/catalog/check-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Accepted {
  accepted: true;
  options: Record<string, string>;
  scale: string;
  measures: { type: string; value: string; unit: string }[];
  material: { id: string; key: string; name: string; price: { unit_price: string; currency: string; source: string } };
}
interface Refused {
  accepted: false;
  reasons: { code: string; message: string; rule_id?: string }[];
}

describe('catalog: checking a configuration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none.
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
    });
    return {
      id: tenant.id,
      ownerId: owner.id,
      owner: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken),
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** The spec's "done when" setup: Silver 925 and Brass, Material and Finish, "gold plated requires silver", a custom cast part. */
  async function castPartSetup(tenant: Tenant) {
    const id = (response: request.Response) => (response.body as { id: string }).id;
    const silver = id(
      await tenant.owner
        .post('/catalog/materials', {
          key: 'silver_925',
          name: 'Silver 925',
          priced_unit: 'g',
          price_source: 'feed',
          feed_metal: runMetal,
          addon_percent: '8',
          addon_amount: '0.20',
          fallback_price: '0.85',
        })
        .expect(201),
    );
    const brass = id(
      await tenant.owner
        .post('/catalog/materials', { key: 'brass', name: 'Brass', priced_unit: 'g', price_source: 'manual', manual_price: '0.012' })
        .expect(201),
    );

    const group = async (key: string) => id(await tenant.owner.post('/catalog/option-groups', { key, name: key }).expect(201));
    const value = async (groupId: string, key: string, materialId?: string) =>
      id(
        await tenant.owner
          .post(`/catalog/option-groups/${groupId}/values`, { key, name: key, material_id: materialId })
          .expect(201),
      );
    const material = await group('material');
    const finish = await group('finish');
    const v = {
      silver: await value(material, 'silver_925', silver),
      brass: await value(material, 'brass', brass),
      raw: await value(finish, 'raw'),
      polished: await value(finish, 'polished'),
      gold: await value(finish, 'gold_plated'),
    };
    const ruleId = id(
      await tenant.owner
        .post('/catalog/option-rules', { kind: 'requires', value_id: v.gold, target_value_ids: [v.silver] })
        .expect(201),
    );

    const categoryId = id(
      await tenant.owner
        .post('/catalog/categories', { key: 'cast_metal', name: 'Cast metal parts', required_measures: ['volume', 'bounding_box_x'] })
        .expect(201),
    );
    const productId = id(
      await tenant.owner
        .post('/catalog/products', {
          category_id: categoryId,
          key: 'custom_cast_part',
          name: 'Custom cast part',
          kind: 'custom',
          sizing: { mode: 'range', min: '0.5', max: '2' },
        })
        .expect(201),
    );
    await tenant.owner
      .put(`/catalog/products/${productId}/options`, {
        groups: [
          { group_id: material, required: true, value_ids: [v.silver, v.brass] },
          { group_id: finish, required: true, default_value_id: v.raw, value_ids: [v.raw, v.polished, v.gold] },
        ],
      })
      .expect(200);

    const design = await measuredDesign(prisma, tenant.id, tenant.ownerId);
    return { silver, brass, ruleId, categoryId, productId, versionId: design.versionId };
  }

  const check = (as: Tenant['owner'], productId: string, body: object) => as.post(`/catalog/products/${productId}/check`, body);

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

  it('refuses brass + gold plated, naming the rule', async () => {
    const tenant = await freshTenant();
    const setup = await castPartSetup(tenant);

    const response = await check(tenant.member, setup.productId, {
      options: { material: 'brass', finish: 'gold_plated' },
      file_version_id: setup.versionId,
    }).expect(200);
    expectDocumented(checkResponseSchema, response.body);
    expect(response.body).toEqual({
      accepted: false,
      reasons: [expect.objectContaining({ code: 'rule_requires', rule_id: setup.ruleId })],
    });
  });

  it('accepts silver + polished at 150 % with scaled measures and the current silver price', async () => {
    const tenant = await freshTenant();
    const setup = await castPartSetup(tenant);
    const body = { options: { material: 'silver_925', finish: 'polished' }, size: { scale: '1.5' }, file_version_id: setup.versionId };

    const fallback = await check(tenant.member, setup.productId, body).expect(200);
    expectDocumented(checkResponseSchema, fallback.body);
    expect(fallback.body).toMatchObject({
      accepted: true,
      options: { material: 'silver_925', finish: 'polished' },
      scale: '1.5',
      material: { id: setup.silver, key: 'silver_925', name: 'Silver 925', price: { unit_price: '0.85', currency: 'EUR', source: 'fallback' } },
    });
    expect((fallback.body as Accepted).measures).toEqual(
      expect.arrayContaining([
        { type: 'volume', value: '3375.000000', unit: 'mm3' },
        { type: 'bounding_box_x', value: '15.000000', unit: 'mm' },
      ]),
    );

    // A feed price arrives: 0.80 × 1.08 + 0.20.
    await prisma.metalPriceSnapshot.create({
      data: { provider: 'fake', metal: runMetal, currency: 'EUR', pricePerGram: '0.80', fetchedAt: new Date() },
    });
    const feed = await check(tenant.member, setup.productId, body).expect(200);
    expect((feed.body as Accepted).material.price).toMatchObject({ unit_price: '1.064', source: 'feed' });

    // An override changes the next check's price.
    await tenant.owner.put(`/catalog/materials/${setup.silver}/price-override`, { price: '0.95' }).expect(200);
    const overridden = await check(tenant.member, setup.productId, body).expect(200);
    expectDocumented(checkResponseSchema, overridden.body);
    expect((overridden.body as Accepted).material.price).toMatchObject({ unit_price: '0.95', source: 'override' });
  });

  it('refuses a custom product without a file, and a material priced in another currency', async () => {
    const tenant = await freshTenant();
    const setup = await castPartSetup(tenant);

    const noFile = await check(tenant.member, setup.productId, { options: { material: 'silver_925' } }).expect(200);
    expect((noFile.body as Refused).reasons.map((reason) => reason.code)).toEqual(['file_required']);

    const usd = (
      await tenant.owner
        .post('/catalog/materials', {
          key: 'resin_usd',
          name: 'Resin bought in USD',
          priced_unit: 'g',
          price_source: 'manual',
          manual_price: '0.1',
          currency: 'USD',
        })
        .expect(201)
    ).body as { id: string };
    const fixed = (
      await tenant.owner
        .post('/catalog/products', {
          category_id: setup.categoryId,
          key: 'custom_resin_print',
          name: 'Custom resin print',
          kind: 'custom',
          material_id: usd.id,
        })
        .expect(201)
    ).body as { id: string };
    const missing = await check(tenant.member, fixed.id, { file_version_id: setup.versionId }).expect(200);
    expectDocumented(checkResponseSchema, missing.body);
    expect(missing.body).toEqual({
      accepted: false,
      reasons: [expect.objectContaining({ code: 'price_missing', message: expect.stringMatching(/USD/) })],
    });
  });

  it('refuses malformed input with a 400', async () => {
    const tenant = await freshTenant();
    const setup = await castPartSetup(tenant);
    const base = { options: { material: 'silver_925' }, file_version_id: setup.versionId };

    for (const body of [
      { ...base, size: { scale: 1.5 } },
      { ...base, size: { scale: '1e3' } },
      { ...base, size: { scale: '-1' } },
      { ...base, size: { scale: '1.123456789' } },
      { ...base, size: { scale: '1.5', named: 'M' } },
      { ...base, options: 'silver' },
      { ...base, options: { material: 3 } },
      { ...base, file_version_id: 'not-a-uuid' },
    ]) {
      const response = await check(tenant.owner, setup.productId, body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
  });

  it("keeps another tenant's product and file out of reach", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const setupA = await castPartSetup(a);
    const versionB = await measuredDesign(prisma, b.id, b.ownerId);

    await check(b.owner, setupA.productId, { options: { material: 'silver_925' } }).expect(404);
    await check(a.owner, setupA.productId, { options: { material: 'silver_925' }, file_version_id: versionB.versionId }).expect(404);
  });
});
