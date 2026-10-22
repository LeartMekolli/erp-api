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

/**
 * The Catalog spec's "Done when", steps 1–6, as the owner through HTTP. Only the design
 * files are written straight to the database, as the measuring job would leave them.
 */
describe('catalog slice: the done-when walkthrough', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

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

  it('walks steps 1 to 6', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const post = (path: string, body: object) =>
      request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body);
    const put = (path: string, body: object) =>
      request(app.getHttpServer()).put(path).set('Authorization', `Bearer ${token}`).send(body);
    const id = (response: request.Response) => (response.body as { id: string }).id;

    // 1. The category "Cast metal parts", requiring volume and bounding box.
    const categoryId = id(
      await post('/catalog/categories', {
        key: 'cast_metal',
        name: 'Cast metal parts',
        required_measures: ['volume', 'bounding_box_x', 'bounding_box_y', 'bounding_box_z'],
      }).expect(201),
    );

    // 2. "Silver 925" from the feed plus 8 %, and "Brass" priced by hand.
    const silver = id(
      await post('/catalog/materials', {
        key: 'silver_925',
        name: 'Silver 925',
        priced_unit: 'g',
        density_g_cm3: '10.36',
        price_source: 'feed',
        feed_metal: runMetal,
        addon_percent: '8',
        fallback_price: '0.85',
      }).expect(201),
    );
    const brass = id(
      await post('/catalog/materials', {
        key: 'brass',
        name: 'Brass',
        priced_unit: 'g',
        density_g_cm3: '8.5',
        price_source: 'manual',
        manual_price: '0.012',
      }).expect(201),
    );

    // 3. Material (silver, brass) and Finish (raw, polished, gold plated); gold plated requires silver.
    const materialGroup = id(await post('/catalog/option-groups', { key: 'material', name: 'Material' }).expect(201));
    const finishGroup = id(await post('/catalog/option-groups', { key: 'finish', name: 'Finish' }).expect(201));
    const value = async (groupId: string, key: string, name: string, materialId?: string) =>
      id(await post(`/catalog/option-groups/${groupId}/values`, { key, name, material_id: materialId }).expect(201));
    const v = {
      silver: await value(materialGroup, 'silver_925', 'Silver 925', silver),
      brass: await value(materialGroup, 'brass', 'Brass', brass),
      raw: await value(finishGroup, 'raw', 'Raw'),
      polished: await value(finishGroup, 'polished', 'Polished'),
      gold: await value(finishGroup, 'gold_plated', 'Gold plated'),
    };
    const ruleId = id(
      await post('/catalog/option-rules', { kind: 'requires', value_id: v.gold, target_value_ids: [v.silver] }).expect(201),
    );

    // 4. "Custom cast part" sized 50–200 %, and "Ring model 12" with its own file in S, M and L.
    const options = {
      groups: [
        { group_id: materialGroup, required: true, value_ids: [v.silver, v.brass] },
        { group_id: finishGroup, required: true, default_value_id: v.raw, value_ids: [v.raw, v.polished, v.gold] },
      ],
    };
    const castPart = id(
      await post('/catalog/products', {
        category_id: categoryId,
        key: 'custom_cast_part',
        name: 'Custom cast part',
        kind: 'custom',
        sizing: { mode: 'range', min: '0.5', max: '2' },
      }).expect(201),
    );
    await put(`/catalog/products/${castPart}/options`, options).expect(200);
    const ring = id(
      await post('/catalog/products', {
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
      }).expect(201),
    );
    await put(`/catalog/products/${ring}/options`, options).expect(200);
    const ringFile = await measuredDesign(prisma, tenant.id, owner.id);
    await put(`/catalog/products/${ring}/design-file`, { file_version_id: ringFile.versionId }).expect(200);

    // 5. Brass + gold plated is refused naming the rule; silver + polished at 150 % is accepted.
    const customerFile = await measuredDesign(prisma, tenant.id, owner.id);
    const refused = await post(`/catalog/products/${castPart}/check`, {
      options: { material: 'brass', finish: 'gold_plated' },
      file_version_id: customerFile.versionId,
    }).expect(200);
    expectDocumented(checkResponseSchema, refused.body);
    expect(refused.body).toEqual({
      accepted: false,
      reasons: [expect.objectContaining({ code: 'rule_requires', rule_id: ruleId })],
    });

    const silverPolished = {
      options: { material: 'silver_925', finish: 'polished' },
      size: { scale: '1.5' },
      file_version_id: customerFile.versionId,
    };
    const accepted = await post(`/catalog/products/${castPart}/check`, silverPolished).expect(200);
    expectDocumented(checkResponseSchema, accepted.body);
    expect(accepted.body).toMatchObject({
      accepted: true,
      scale: '1.5',
      material: { key: 'silver_925', price: { unit_price: '0.85', source: 'fallback' } },
    });
    expect((accepted.body as { measures: unknown[] }).measures).toContainEqual({
      type: 'volume',
      value: '3375.000000',
      unit: 'mm3',
    });

    const ringL = await post(`/catalog/products/${ring}/check`, {
      options: { material: 'silver_925' },
      size: { named: 'L' },
    }).expect(200);
    expect(ringL.body).toMatchObject({ accepted: true, scale: '1.1', options: { material: 'silver_925', finish: 'raw' } });

    // 6. An override by hand shows in the next check.
    await put(`/catalog/materials/${silver}/price-override`, { price: '0.95', reason: 'agreed with supplier' }).expect(200);
    const overridden = await post(`/catalog/products/${castPart}/check`, silverPolished).expect(200);
    expect(overridden.body).toMatchObject({
      accepted: true,
      material: { key: 'silver_925', price: { unit_price: '0.95', source: 'override' } },
    });
  });
});
