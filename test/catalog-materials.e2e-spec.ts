import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { materialResponseSchema } from '../src/modules/catalog/material-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface MaterialBody {
  id: string;
  current_price: { unit_price: string; currency: string; per_unit: string; source: string; stale: boolean } | null;
  price_missing: string | null;
  override: { price: string; reason: string | null } | null;
}

describe('catalog: materials', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function freshTenant(): Promise<{ id: string; ownerToken: string; editorToken: string; memberToken: string }> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    // Can edit the catalog, but not override prices.
    const editor = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      const role = await tx.role.create({ data: { name: 'catalog editor' } });
      await tx.rolePermission.createMany({
        data: ['catalog.read', 'catalog.write'].map((permission) => ({ roleId: role.id, permission })),
      });
      await tx.userRole.create({ data: { userId: editor.id, roleId: role.id } });
    });
    return {
      id: tenant.id,
      ownerToken: (await tokens.issueForUser(tenant.id, owner.id)).accessToken,
      editorToken: (await tokens.issueForUser(tenant.id, editor.id)).accessToken,
      memberToken: (await tokens.issueForUser(tenant.id, member.id)).accessToken,
    };
  }

  const brass = { key: 'brass', name: 'Brass', priced_unit: 'g', density_g_cm3: '8.5', price_source: 'manual', manual_price: '0.012' };
  const silver = {
    key: 'silver_925',
    name: 'Silver 925',
    priced_unit: 'g',
    density_g_cm3: '10.36',
    price_source: 'feed',
    feed_metal: 'silver',
    addon_percent: '8',
    fallback_price: '0.85',
  };

  const create = (token: string, body: object) => http().post('/catalog/materials').set(auth(token)).send(body);

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

  it('creates manual and feed materials and shows their current price', async () => {
    const tenant = await freshTenant();

    const manual = await create(tenant.ownerToken, brass).expect(201);
    expectDocumented(materialResponseSchema, manual.body);
    expect((manual.body as MaterialBody).current_price).toMatchObject({
      unit_price: '0.012',
      currency: 'EUR',
      per_unit: 'g',
      source: 'manual',
    });

    // No snapshot exists yet, so the fallback applies.
    const feed = await create(tenant.ownerToken, silver).expect(201);
    expect((feed.body as MaterialBody).current_price).toMatchObject({ unit_price: '0.85', source: 'fallback' });

    const listed = await http().get('/catalog/materials').set(auth(tenant.memberToken)).expect(200);
    expectDocumented(pageSchema(materialResponseSchema), listed.body);
    expect((listed.body as { data: unknown[] }).data).toHaveLength(2);

    const one = await http().get(`/catalog/materials/${(feed.body as MaterialBody).id}`).set(auth(tenant.memberToken)).expect(200);
    expectDocumented(materialResponseSchema, one.body);
  });

  it('refuses incomplete or impossible materials', async () => {
    const tenant = await freshTenant();

    const bad = [
      { ...silver, fallback_price: undefined }, // a feed needs a fallback (B6)
      { ...silver, feed_metal: undefined },
      { ...silver, priced_unit: 'cm3' }, // a feed is priced by mass
      { ...brass, manual_price: undefined },
      { ...brass, priced_unit: 'mm' }, // length is not a priced unit
      { ...brass, priced_unit: 'parsec' },
      { ...brass, manual_price: '-1' },
      { ...brass, manual_price: '1e3' },
      { ...brass, key: 'Brass Metal' },
    ];
    for (const body of bad) {
      const response = await create(tenant.ownerToken, body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }

    await create(tenant.ownerToken, brass).expect(201);
    await create(tenant.ownerToken, brass).expect(409);
    await create(tenant.memberToken, { ...brass, key: 'other' }).expect(403);
  });

  it('edits a material', async () => {
    const tenant = await freshTenant();
    const { id } = (await create(tenant.ownerToken, brass).expect(201)).body as MaterialBody;

    const edited = await http()
      .patch(`/catalog/materials/${id}`)
      .set(auth(tenant.editorToken))
      .send({ name: 'Brass CuZn37', manual_price: '0.015' })
      .expect(200);
    expect(edited.body).toMatchObject({ name: 'Brass CuZn37', current_price: { unit_price: '0.015' } });

    // Switching to a feed without a fallback leaves the material incomplete.
    await http().patch(`/catalog/materials/${id}`).set(auth(tenant.ownerToken)).send({ price_source: 'feed', feed_metal: 'copper' }).expect(400);
  });

  it('overrides a price by hand, audited, and removes the override', async () => {
    const tenant = await freshTenant();
    const { id } = (await create(tenant.ownerToken, silver).expect(201)).body as MaterialBody;

    await http().put(`/catalog/materials/${id}/price-override`).set(auth(tenant.editorToken)).send({ price: '0.95' }).expect(403);

    const overridden = await http()
      .put(`/catalog/materials/${id}/price-override`)
      .set(auth(tenant.ownerToken))
      .send({ price: '0.95', reason: 'agreed with supplier' })
      .expect(200);
    expectDocumented(materialResponseSchema, overridden.body);
    expect(overridden.body).toMatchObject({
      override: { price: '0.95', reason: 'agreed with supplier' },
      current_price: { unit_price: '0.95', source: 'override' },
    });

    await http().delete(`/catalog/materials/${id}/price-override`).set(auth(tenant.ownerToken)).expect(204);
    const after = await http().get(`/catalog/materials/${id}`).set(auth(tenant.ownerToken)).expect(200);
    expect(after.body).toMatchObject({ override: null, current_price: { source: 'fallback' } });

    const entries = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.findMany({ where: { subjectId: id }, orderBy: { id: 'asc' } }),
    );
    expect(entries.map((entry) => entry.action)).toEqual(['material.price_overridden', 'material.price_override_removed']);
    expect(entries[0]).toMatchObject({
      before: { override_price: null },
      after: { override_price: '0.95', reason: 'agreed with supplier' },
    });
  });

  it("keeps a tenant's materials to itself", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const { id } = (await create(a.ownerToken, brass).expect(201)).body as MaterialBody;

    await http().get(`/catalog/materials/${id}`).set(auth(b.ownerToken)).expect(404);
    await http().patch(`/catalog/materials/${id}`).set(auth(b.ownerToken)).send({ name: 'x' }).expect(404);
    await http().put(`/catalog/materials/${id}/price-override`).set(auth(b.ownerToken)).send({ price: '1' }).expect(404);
  });
});
