import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

type Method = 'get' | 'post' | 'put' | 'delete';

describe('users and roles administration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const call = (method: Method, path: string, token: string, body?: object) => {
    const pending = request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`);
    return body ? pending.send(body) : pending;
  };

  async function freshTenant(): Promise<{ id: string; ownerId: string; ownerToken: string }> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    return { id: tenant.id, ownerId: owner.id, ownerToken: await tokenFor(tenant.id, owner.id) };
  }

  async function tokenFor(tenantId: string, userId: string): Promise<string> {
    return (await tokens.issueForUser(tenantId, userId)).accessToken;
  }

  const roleId = (tenantId: string, name: string) =>
    prisma.inTenant(tenantId, async (tx) => (await tx.role.findFirstOrThrow({ where: { name } })).id);

  const roleIdsOf = (tenantId: string, userId: string) =>
    prisma.inTenant(tenantId, async (tx) =>
      (await tx.userRole.findMany({ where: { userId } })).map((row) => row.roleId).sort(),
    );

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

  describe('users', () => {
    it('lists users newest first with a cursor, and never a hash', async () => {
      const tenant = await freshTenant();
      await createTestUser(prisma, tenant.id);
      await createTestUser(prisma, tenant.id);

      const first = await call('get', '/users?limit=2', tenant.ownerToken).expect(200);
      const page = first.body as { data: Record<string, unknown>[]; next_cursor: string | null };
      expect(page.data).toHaveLength(2);
      expect(page.next_cursor).not.toBeNull();
      for (const user of page.data) {
        expect(Object.keys(user).sort()).toEqual(['created_at', 'email', 'id', 'locale', 'name', 'status']);
      }

      const second = await call('get', `/users?limit=2&cursor=${page.next_cursor}`, tenant.ownerToken).expect(200);
      const rest = second.body as { data: { id: string }[]; next_cursor: string | null };
      expect(rest.data).toHaveLength(1);
      expect(rest.next_cursor).toBeNull();
      expect(rest.data[0]?.id).toBe(tenant.ownerId);
    });

    it('filters users by status', async () => {
      const tenant = await freshTenant();
      const inactive = await createTestUser(prisma, tenant.id, { status: 'deactivated' });

      const response = await call('get', '/users?status=deactivated', tenant.ownerToken).expect(200);

      expect((response.body as { data: { id: string }[] }).data.map((user) => user.id)).toEqual([inactive.id]);
    });

    it('refuses to remove the owner role from the only owner, and changes nothing', async () => {
      const tenant = await freshTenant();
      const memberRole = await roleId(tenant.id, 'member');
      const before = await roleIdsOf(tenant.id, tenant.ownerId);

      await call('put', `/users/${tenant.ownerId}/roles`, tenant.ownerToken, { role_ids: [memberRole] }).expect(409);

      await expect(roleIdsOf(tenant.id, tenant.ownerId)).resolves.toEqual(before);
    });

    it('refuses to deactivate the only owner, but allows it once there is another', async () => {
      const tenant = await freshTenant();
      await call('post', `/users/${tenant.ownerId}/deactivate`, tenant.ownerToken).expect(409);

      const second = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
      const secondToken = await tokenFor(tenant.id, second.id);
      await call('post', `/users/${second.id}/deactivate`, tenant.ownerToken).expect(204);

      await call('get', '/users', secondToken).expect(401);
      const entries = await prisma.inTenant(tenant.id, (tx) =>
        tx.auditEntry.findMany({ where: { action: 'user.deactivated', subjectId: second.id } }),
      );
      expect(entries).toHaveLength(1);
    });

    it('assigns roles and audits the before and after', async () => {
      const tenant = await freshTenant();
      const user = await createTestUser(prisma, tenant.id, { roles: ['member'] });
      const memberRole = await roleId(tenant.id, 'member');
      const ownerRole = await roleId(tenant.id, 'owner');

      const response = await call('put', `/users/${user.id}/roles`, tenant.ownerToken, {
        role_ids: [ownerRole, memberRole],
      }).expect(200);

      expect((response.body as { role_ids: string[] }).role_ids.sort()).toEqual([memberRole, ownerRole].sort());
      const entry = await prisma.inTenant(tenant.id, (tx) =>
        tx.auditEntry.findFirstOrThrow({ where: { action: 'user.roles_changed', subjectId: user.id } }),
      );
      expect(entry).toMatchObject({
        actorId: tenant.ownerId,
        before: { role_ids: [memberRole] },
        after: { role_ids: [memberRole, ownerRole].sort() },
      });
    });

    it("refuses another tenant's role id with 404 and writes nothing", async () => {
      const tenant = await freshTenant();
      const other = await freshTenant();
      const user = await createTestUser(prisma, tenant.id, { roles: ['member'] });
      const foreignRole = await roleId(other.id, 'owner');
      const before = await roleIdsOf(tenant.id, user.id);

      await call('put', `/users/${user.id}/roles`, tenant.ownerToken, { role_ids: [foreignRole] }).expect(404);

      await expect(roleIdsOf(tenant.id, user.id)).resolves.toEqual(before);
      await expect(
        prisma.inTenant(tenant.id, (tx) => tx.auditEntry.count({ where: { action: 'user.roles_changed' } })),
      ).resolves.toBe(0);
    });

    it("answers 404 for an unknown user and for another tenant's user", async () => {
      const tenant = await freshTenant();
      const other = await freshTenant();
      const memberRole = await roleId(tenant.id, 'member');

      await call('post', `/users/${newId()}/deactivate`, tenant.ownerToken).expect(404);
      await call('post', `/users/${other.ownerId}/deactivate`, tenant.ownerToken).expect(404);
      await call('put', `/users/${other.ownerId}/roles`, tenant.ownerToken, { role_ids: [memberRole] }).expect(404);
    });

    it('validates the role list', async () => {
      const tenant = await freshTenant();
      const memberRole = await roleId(tenant.id, 'member');

      await call('put', `/users/${tenant.ownerId}/roles`, tenant.ownerToken, { role_ids: [] }).expect(400);
      await call('put', `/users/${tenant.ownerId}/roles`, tenant.ownerToken, {
        role_ids: [memberRole, memberRole],
      }).expect(400);
      await call('put', `/users/not-a-uuid/roles`, tenant.ownerToken, { role_ids: [memberRole] }).expect(400);
    });
  });

  describe('roles', () => {
    it('lists roles with their permissions', async () => {
      const tenant = await freshTenant();

      const response = await call('get', '/roles', tenant.ownerToken).expect(200);
      const roles = (response.body as { data: { name: string; is_system: boolean; permissions: string[] }[] }).data;

      expect(roles.map((role) => [role.name, role.is_system])).toEqual([
        ['member', true],
        ['owner', true],
      ]);
      expect(roles.find((role) => role.name === 'member')?.permissions).toEqual([
        'catalog.read',
        'customer.read',
        'file.read',
        'partner.read',
        'quote.create',
        'role.read',
        'settings.read',
        'template.read',
        'user.read',
        'workflow.move',
        'workflow.read',
      ]);
    });

    it('creates, changes and deletes a custom role, auditing each step', async () => {
      const tenant = await freshTenant();

      const created = await call('post', '/roles', tenant.ownerToken, {
        name: 'Production lead',
        permissions: ['user.read'],
      }).expect(201);
      const role = created.body as { id: string; name: string; is_system: boolean; permissions: string[] };
      expect(role).toMatchObject({ name: 'Production lead', is_system: false, permissions: ['user.read'] });

      await call('put', `/roles/${role.id}/permissions`, tenant.ownerToken, {
        permissions: ['user.read', 'settings.read'],
      }).expect(200, { ...role, permissions: ['settings.read', 'user.read'] });

      await call('delete', `/roles/${role.id}`, tenant.ownerToken).expect(204);

      const actions = await prisma.inTenant(tenant.id, async (tx) =>
        (await tx.auditEntry.findMany({ where: { subjectId: role.id }, orderBy: { createdAt: 'asc' } })).map(
          (entry) => entry.action,
        ),
      );
      expect(actions).toEqual(['role.created', 'role.permissions_changed', 'role.deleted']);
    });

    it("applies a custom role's permissions from the next request", async () => {
      const tenant = await freshTenant();
      const user = await createTestUser(prisma, tenant.id, { roles: [] });
      const userToken = await tokenFor(tenant.id, user.id);
      await call('get', '/users', userToken).expect(403);

      const role = (
        await call('post', '/roles', tenant.ownerToken, { name: 'Viewer', permissions: ['user.read'] }).expect(201)
      ).body as { id: string };
      await call('put', `/users/${user.id}/roles`, tenant.ownerToken, { role_ids: [role.id] }).expect(200);
      await call('get', '/users', userToken).expect(200);

      await call('put', `/roles/${role.id}/permissions`, tenant.ownerToken, { permissions: [] }).expect(200);
      await call('get', '/users', userToken).expect(403);
    });

    it('protects system roles from edits and deletion', async () => {
      const tenant = await freshTenant();
      const ownerRole = await roleId(tenant.id, 'owner');

      await call('put', `/roles/${ownerRole}/permissions`, tenant.ownerToken, { permissions: [] }).expect(409);
      await call('delete', `/roles/${ownerRole}`, tenant.ownerToken).expect(409);
    });

    it('refuses duplicate names, unknown permissions and platform permissions', async () => {
      const tenant = await freshTenant();

      await call('post', '/roles', tenant.ownerToken, { name: 'owner', permissions: [] }).expect(409);
      await call('post', '/roles', tenant.ownerToken, { name: 'Bad', permissions: ['made.up'] }).expect(400);
      await call('post', '/roles', tenant.ownerToken, {
        name: 'Sneaky',
        permissions: ['platform.tenant.create'],
      }).expect(400);
    });
  });

  it('refuses every write route to a member', async () => {
    const tenant = await freshTenant();
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const memberToken = await tokenFor(tenant.id, member.id);
    const ownerRole = await roleId(tenant.id, 'owner');

    await call('post', `/users/${tenant.ownerId}/deactivate`, memberToken).expect(403);
    await call('put', `/users/${member.id}/roles`, memberToken, { role_ids: [ownerRole] }).expect(403);
    await call('post', '/roles', memberToken, { name: 'Mine', permissions: [] }).expect(403);
    await call('put', `/roles/${ownerRole}/permissions`, memberToken, { permissions: [] }).expect(403);
    await call('delete', `/roles/${ownerRole}`, memberToken).expect(403);
    await call('get', '/users', memberToken).expect(200);
    await call('get', '/roles', memberToken).expect(200);
  });
});
