import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

describe('catalog: units', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function freshTenant(): Promise<{ ownerToken: string; memberToken: string }> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    return {
      ownerToken: (await tokens.issueForUser(tenant.id, owner.id)).accessToken,
      memberToken: (await tokens.issueForUser(tenant.id, member.id)).accessToken,
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

  const pennyweight = { key: 'dwt', name: 'Pennyweight', dimension: 'mass', factor: '1.55517384' };

  it('lists the seeded units and adds a tenant unit', async () => {
    const { ownerToken } = await freshTenant();

    const before = await http().get('/catalog/units').set(auth(ownerToken)).expect(200);
    const keys = (before.body as { data: { key: string }[] }).data.map((unit) => unit.key);
    expect(keys).toEqual(
      expect.arrayContaining(['mm', 'cm', 'm', 'mm2', 'cm2', 'mm3', 'cm3', 'ml', 'g', 'kg', 'toz', 'piece']),
    );
    expect(keys).toHaveLength(12);

    const created = await http().post('/catalog/units').set(auth(ownerToken)).send(pennyweight).expect(201);
    expect(created.body).toMatchObject({ ...pennyweight, seeded: false });

    const after = await http().get('/catalog/units').set(auth(ownerToken)).expect(200);
    expect((after.body as { data: { key: string }[] }).data.map((unit) => unit.key)).toContain('dwt');
  });

  it('refuses a key that is taken, a dimension that does not exist and a factor that is not positive', async () => {
    const { ownerToken } = await freshTenant();

    await http().post('/catalog/units').set(auth(ownerToken)).send({ ...pennyweight, key: 'g' }).expect(409);
    await http().post('/catalog/units').set(auth(ownerToken)).send(pennyweight).expect(201);
    await http().post('/catalog/units').set(auth(ownerToken)).send(pennyweight).expect(409);
    await http().post('/catalog/units').set(auth(ownerToken)).send({ ...pennyweight, key: 'h', dimension: 'time' }).expect(400);
    await http().post('/catalog/units').set(auth(ownerToken)).send({ ...pennyweight, key: 'z', factor: '0' }).expect(400);
    await http().post('/catalog/units').set(auth(ownerToken)).send({ ...pennyweight, key: 'y', factor: '1e3' }).expect(400);
  });

  it('keeps tenant units to their tenant', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    await http().post('/catalog/units').set(auth(a.ownerToken)).send(pennyweight).expect(201);

    const listed = await http().get('/catalog/units').set(auth(b.ownerToken)).expect(200);
    expect((listed.body as { data: { key: string }[] }).data.map((unit) => unit.key)).not.toContain('dwt');
  });

  it('lets a member read units but not add them', async () => {
    const { memberToken } = await freshTenant();

    await http().get('/catalog/units').set(auth(memberToken)).expect(200);
    await http().post('/catalog/units').set(auth(memberToken)).send(pennyweight).expect(403);
  });
});
