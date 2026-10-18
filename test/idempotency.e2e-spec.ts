import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { IdempotencyCleanupHandler } from '../src/modules/idempotency/idempotency-cleanup.handler';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { RedisService } from '../src/redis/redis.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

describe('idempotency keys', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  async function freshOwner(): Promise<{ tenantId: string; token: string }> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    return { tenantId: tenant.id, token: (await tokens.issueForUser(tenant.id, owner.id)).accessToken };
  }

  const createRole = (token: string, body: object, key?: string) => {
    const pending = request(app.getHttpServer()).post('/roles').set('Authorization', `Bearer ${token}`);
    return (key ? pending.set('Idempotency-Key', key) : pending).send(body);
  };

  const rolesNamed = (tenantId: string, name: string) =>
    prisma.inTenant(tenantId, (tx) => tx.role.count({ where: { name } }));

  const keyRow = (tenantId: string, key: string) =>
    prisma.inTenant(tenantId, (tx) => tx.idempotencyKey.findFirst({ where: { key } }));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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

  it('a repeat replays the first response and creates nothing', async () => {
    const owner = await freshOwner();
    const key = newId();
    const body = { name: 'Packer', permissions: ['user.read'] };

    const first = await createRole(owner.token, body, key).expect(201);
    const second = await createRole(owner.token, body, key).expect(201);

    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.body).toEqual(first.body);
    expect(await rolesNamed(owner.tenantId, 'Packer')).toBe(1);
  });

  it('the same key with another body gives 409', async () => {
    const owner = await freshOwner();
    const key = newId();
    await createRole(owner.token, { name: 'Cutter', permissions: [] }, key).expect(201);

    const conflict = await createRole(owner.token, { name: 'Other', permissions: [] }, key).expect(409);
    expect(conflict.body.detail).toBe('Idempotency key reused with a different request');
    expect(await rolesNamed(owner.tenantId, 'Other')).toBe(0);
  });

  it('two concurrent requests create one role', async () => {
    const owner = await freshOwner();
    const key = newId();
    const body = { name: 'Racer', permissions: [] };

    const responses = await Promise.all([
      createRole(owner.token, body, key),
      createRole(owner.token, body, key),
    ]);
    const statuses = responses.map((response) => response.status).sort();

    // The loser either sees the stored response or the key still in progress.
    expect([
      [201, 201],
      [201, 409],
    ]).toContainEqual(statuses);
    expect(await rolesNamed(owner.tenantId, 'Racer')).toBe(1);
  });

  it("a failed request doesn't poison the key", async () => {
    const owner = await freshOwner();
    const key = newId();

    await createRole(owner.token, { name: '', permissions: [] }, key).expect(400);
    expect(await keyRow(owner.tenantId, key)).toBeNull();

    await createRole(owner.token, { name: 'Fixed', permissions: [] }, key).expect(201);
    expect(await rolesNamed(owner.tenantId, 'Fixed')).toBe(1);
  });

  it('keys are per tenant', async () => {
    const a = await freshOwner();
    const b = await freshOwner();
    const key = newId();
    const body = { name: 'Shared', permissions: [] };

    await createRole(a.token, body, key).expect(201);
    const fromB = await createRole(b.token, body, key).expect(201);

    expect(fromB.headers['idempotent-replayed']).toBeUndefined();
    expect(await rolesNamed(a.tenantId, 'Shared')).toBe(1);
    expect(await rolesNamed(b.tenantId, 'Shared')).toBe(1);
  });

  it('an in-progress key gives 409, and is reclaimed once abandoned for 60 s', async () => {
    const owner = await freshOwner();
    const key = newId();
    const body = { name: 'Late', permissions: [] };

    // A request that claimed the key and then died before finishing.
    await createRole(owner.token, body, key).expect(201);
    await moduleRef.get(RedisService).client.del(`idempotency:${owner.tenantId}:${key}`);
    await prisma.inTenant(owner.tenantId, async (tx) => {
      await tx.idempotencyKey.updateMany({
        where: { key },
        data: { status: 'in_progress', responseStatus: null, completedAt: null },
      });
      await tx.role.deleteMany({ where: { name: 'Late' } });
    });

    const busy = await createRole(owner.token, body, key).expect(409);
    expect(busy.body.detail).toBe('A request with this key is in progress');

    await prisma.inTenant(owner.tenantId, (tx) =>
      tx.idempotencyKey.updateMany({ where: { key }, data: { createdAt: new Date(Date.now() - 61_000) } }),
    );
    await createRole(owner.token, body, key).expect(201);
    expect(await rolesNamed(owner.tenantId, 'Late')).toBe(1);
  });

  it('requests without the header behave as before', async () => {
    const owner = await freshOwner();
    await createRole(owner.token, { name: 'Plain', permissions: [] }).expect(201);
    await createRole(owner.token, { name: 'Plain', permissions: [] }).expect(409);
    expect(await prisma.inTenant(owner.tenantId, (tx) => tx.idempotencyKey.count())).toBe(0);
  });

  it('a malformed key gives 400', async () => {
    const owner = await freshOwner();
    await createRole(owner.token, { name: 'Bad', permissions: [] }, 'has space').expect(400);
    await createRole(owner.token, { name: 'Bad', permissions: [] }, 'x'.repeat(256)).expect(400);
    expect(await rolesNamed(owner.tenantId, 'Bad')).toBe(0);
  });

  it('the cleanup handler deletes rows older than 30 days and keeps newer ones', async () => {
    const owner = await freshOwner();
    await createRole(owner.token, { name: 'Old', permissions: [] }, 'old-key').expect(201);
    await createRole(owner.token, { name: 'New', permissions: [] }, 'new-key').expect(201);
    await prisma.inTenant(owner.tenantId, (tx) =>
      tx.idempotencyKey.updateMany({
        where: { key: 'old-key' },
        data: { createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
      }),
    );

    await moduleRef.get(IdempotencyCleanupHandler, { strict: false }).handle();

    expect(await keyRow(owner.tenantId, 'old-key')).toBeNull();
    expect(await keyRow(owner.tenantId, 'new-key')).not.toBeNull();
  });
});
