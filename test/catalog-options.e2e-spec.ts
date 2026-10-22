import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import {
  optionGroupResponseSchema,
  optionRuleResponseSchema,
  optionValueResponseSchema,
} from '../src/modules/catalog/option-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Value {
  id: string;
  key: string;
  material_id: string | null;
}
interface Group {
  id: string;
  key: string;
  values: Value[];
}

describe('catalog: option groups, values and rules', () => {
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
    const ownerToken = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const memberToken = (await tokens.issueForUser(tenant.id, member.id)).accessToken;
    const as = (token: string) => ({
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
      delete: (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`),
    });
    return { id: tenant.id, owner: as(ownerToken), member: as(memberToken) };
  }

  /** Material and finish groups, with silver and brass materials behind the material values. */
  async function catalogOf(tenant: Awaited<ReturnType<typeof freshTenant>>) {
    const material = async (key: string) =>
      ((await tenant.owner
        .post('/catalog/materials', { key, name: key, priced_unit: 'g', price_source: 'manual', manual_price: '1' })
        .expect(201)).body as { id: string }).id;
    const silver = await material('silver_925');
    const brass = await material('brass');

    const group = async (key: string) =>
      ((await tenant.owner.post('/catalog/option-groups', { key, name: key }).expect(201)).body as Group).id;
    const value = async (groupId: string, key: string, materialId?: string) =>
      ((await tenant.owner
        .post(`/catalog/option-groups/${groupId}/values`, { key, name: key, material_id: materialId })
        .expect(201)).body as Value).id;

    const materialGroup = await group('material');
    const finishGroup = await group('finish');
    return {
      silver,
      materialGroup,
      finishGroup,
      silverValue: await value(materialGroup, 'silver_925', silver),
      brassValue: await value(materialGroup, 'brass', brass),
      raw: await value(finishGroup, 'raw'),
      polished: await value(finishGroup, 'polished'),
      goldPlated: await value(finishGroup, 'gold_plated'),
    };
  }

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

  it('creates groups with values, some selecting a material, and lists them', async () => {
    const tenant = await freshTenant();
    const ids = await catalogOf(tenant);

    const listed = await tenant.member.get('/catalog/option-groups').expect(200);
    expectDocumented(z.strictObject({ data: z.array(optionGroupResponseSchema) }), listed.body);
    const groups = (listed.body as { data: Group[] }).data;
    expect(groups.map((group) => group.key).sort()).toEqual(['finish', 'material']);
    const material = groups.find((group) => group.key === 'material');
    expect(material?.values).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'silver_925', material_id: ids.silver })]),
    );

    const renamed = await tenant.owner.patch(`/catalog/option-values/${ids.raw}`, { name: 'Raw cast' }).expect(200);
    expectDocumented(optionValueResponseSchema, renamed.body);
    expect(renamed.body).toMatchObject({ name: 'Raw cast', material_id: null });
  });

  it('creates, lists and deletes rules', async () => {
    const tenant = await freshTenant();
    const ids = await catalogOf(tenant);

    const requires = await tenant.owner
      .post('/catalog/option-rules', { kind: 'requires', value_id: ids.goldPlated, target_value_ids: [ids.silverValue] })
      .expect(201);
    expectDocumented(optionRuleResponseSchema, requires.body);
    await tenant.owner
      .post('/catalog/option-rules', { kind: 'excludes', value_id: ids.brassValue, target_value_ids: [ids.polished] })
      .expect(201);

    const listed = await tenant.member.get('/catalog/option-rules').expect(200);
    expectDocumented(z.strictObject({ data: z.array(optionRuleResponseSchema) }), listed.body);
    expect((listed.body as { data: unknown[] }).data).toHaveLength(2);

    await tenant.owner.delete(`/catalog/option-rules/${(requires.body as { id: string }).id}`).expect(204);
    expect(((await tenant.owner.get('/catalog/option-rules').expect(200)).body as { data: unknown[] }).data).toHaveLength(1);
  });

  it('refuses duplicates, self-references and bad input', async () => {
    const tenant = await freshTenant();
    const ids = await catalogOf(tenant);

    await tenant.owner.post('/catalog/option-groups', { key: 'material', name: 'Again' }).expect(409);
    await tenant.owner.post(`/catalog/option-groups/${ids.finishGroup}/values`, { key: 'raw', name: 'Again' }).expect(409);
    await tenant.owner.post('/catalog/option-groups', { key: 'Bad Key', name: 'x' }).expect(400);

    const rule = (body: object) => tenant.owner.post('/catalog/option-rules', body);
    await rule({ kind: 'requires', value_id: ids.goldPlated, target_value_ids: [ids.goldPlated] }).expect(400);
    await rule({ kind: 'requires', value_id: ids.goldPlated, target_value_ids: [] }).expect(400);
    await rule({ kind: 'requires', value_id: ids.goldPlated, target_value_ids: [ids.silverValue, ids.silverValue] }).expect(400);
    await rule({ kind: 'prefers', value_id: ids.goldPlated, target_value_ids: [ids.silverValue] }).expect(400);
  });

  it('keeps every reference inside the tenant', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const idsA = await catalogOf(a);
    const idsB = await catalogOf(b);

    // B's material behind A's value, a value under B's group, a rule mixing tenants: all unknown to A.
    await a.owner.post(`/catalog/option-groups/${idsA.finishGroup}/values`, { key: 'x', name: 'x', material_id: idsB.silver }).expect(404);
    await a.owner.post(`/catalog/option-groups/${idsB.finishGroup}/values`, { key: 'x', name: 'x' }).expect(404);
    await a.owner.patch(`/catalog/option-values/${idsB.raw}`, { name: 'x' }).expect(404);
    await a.owner
      .post('/catalog/option-rules', { kind: 'requires', value_id: idsA.goldPlated, target_value_ids: [idsB.silverValue] })
      .expect(404);
    await a.owner
      .post('/catalog/option-rules', { kind: 'requires', value_id: idsB.goldPlated, target_value_ids: [idsA.silverValue] })
      .expect(404);
  });

  it('lets a member read options but not change them', async () => {
    const tenant = await freshTenant();
    await tenant.member.get('/catalog/option-groups').expect(200);
    await tenant.member.get('/catalog/option-rules').expect(200);
    await tenant.member.post('/catalog/option-groups', { key: 'size', name: 'Size' }).expect(403);
  });
});
