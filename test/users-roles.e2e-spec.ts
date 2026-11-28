import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { staffUserListResponseSchema } from '../src/modules/users/user-response';
import { expectDocumented } from './documented';
import { TEST_PASSWORD, createTestTenant, createTestUser, deleteTestTenants } from './factories';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

describe('users and roles administration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const call = (method: Method, path: string, token: string, body?: object) => {
    const pending = request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`);
    return body ? pending.send(body) : pending;
  };

  async function freshTenant(): Promise<{ id: string; slug: string; ownerId: string; ownerToken: string }> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    return { id: tenant.id, slug: tenant.slug, ownerId: owner.id, ownerToken: await tokenFor(tenant.id, owner.id) };
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

  type Tenant = { id: string; ownerId: string; ownerToken: string };

  const createRole = async (tenant: Tenant, name: string, permissions: string[]): Promise<string> =>
    ((await call('post', '/roles', tenant.ownerToken, { name, permissions }).expect(201)).body as { id: string }).id;

  /** A user holding only a new custom role with exactly these permissions. */
  async function leadWith(tenant: Tenant, permissions: string[]) {
    const lead = await createTestUser(prisma, tenant.id, { roles: [] });
    const leadRole = await createRole(tenant, 'Lead', permissions);
    await call('put', `/users/${lead.id}/roles`, tenant.ownerToken, { role_ids: [leadRole] }).expect(200);
    return { id: lead.id, token: await tokenFor(tenant.id, lead.id), roleId: leadRole };
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
        expect(Object.keys(user).sort()).toEqual([
          'created_at',
          'email',
          'id',
          'locale',
          'name',
          'roles',
          'skills',
          'status',
        ]);
      }
      expectDocumented(staffUserListResponseSchema, first.body);

      const second = await call('get', `/users?limit=2&cursor=${page.next_cursor}`, tenant.ownerToken).expect(200);
      const rest = second.body as { data: { id: string }[]; next_cursor: string | null };
      expect(rest.data).toHaveLength(1);
      expect(rest.next_cursor).toBeNull();
      expect(rest.data[0]?.id).toBe(tenant.ownerId);
    });

    it("lists each person's roles by name and skills by name, with expired and archived marked", async () => {
      const tenant = await freshTenant();
      const person = await createTestUser(prisma, tenant.id, { roles: ['member'] });
      const memberRole = await roleId(tenant.id, 'member');
      const leadRole = await createRole(tenant, 'Lead', ['user.read']);
      await call('put', `/users/${person.id}/roles`, tenant.ownerToken, { role_ids: [memberRole, leadRole] }).expect(200);

      const createSkill = async (name: string): Promise<string> =>
        ((await call('post', '/skills', tenant.ownerToken, { name }).expect(201)).body as { id: string }).id;
      const alpha = await createSkill('Alpha');
      const casting = await createSkill('Casting');
      const zinc = await createSkill('Zinc');
      const nextYear = `${new Date().getUTCFullYear() + 1}-06-30`;
      await call('put', `/users/${person.id}/skills`, tenant.ownerToken, {
        skills: [
          { skill_id: alpha, expires_on: nextYear },
          { skill_id: zinc, expires_on: null },
        ],
      }).expect(200);
      // The tenant's zone is UTC, so its yesterday is the UTC date a day back.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await prisma.inTenant(tenant.id, (tx) =>
        tx.userSkill.create({
          data: {
            userId: person.id,
            skillId: casting,
            expiresOn: new Date(`${yesterday}T00:00:00Z`),
            grantedByUserId: tenant.ownerId,
          },
        }),
      );
      await call('patch', `/skills/${zinc}`, tenant.ownerToken, { archived: true }).expect(200);

      const response = await call('get', '/users', tenant.ownerToken).expect(200);

      expectDocumented(staffUserListResponseSchema, response.body);
      const listed = (response.body as { data: { id: string; roles: unknown[]; skills: unknown[] }[] }).data.find(
        (user) => user.id === person.id,
      );
      expect(listed?.roles).toEqual([
        { id: leadRole, name: 'Lead', is_system: false },
        { id: memberRole, name: 'member', is_system: true },
      ]);
      expect(listed?.skills).toEqual([
        { id: alpha, name: 'Alpha', expires_on: nextYear, expired: false, archived: false },
        { id: casting, name: 'Casting', expires_on: yesterday, expired: true, archived: false },
        { id: zinc, name: 'Zinc', expires_on: null, expired: false, archived: true },
      ]);
    });

    it('searches name and email with q, ignoring case, and pages through the matches', async () => {
      const tenant = await freshTenant();
      const byName = await createTestUser(prisma, tenant.id);
      await prisma.inTenant(tenant.id, (tx) => tx.user.update({ where: { id: byName.id }, data: { name: 'Mara Quint' } }));
      const byEmail = await createTestUser(prisma, tenant.id, { email: `quint-${newId()}@example.test` });
      await createTestUser(prisma, tenant.id);
      const idsOf = (response: { body: unknown }) => (response.body as { data: { id: string }[] }).data.map((user) => user.id);

      const found = await call('get', '/users?q=quint', tenant.ownerToken).expect(200);
      expect(idsOf(found).sort()).toEqual([byName.id, byEmail.id].sort());

      const shouted = await call('get', '/users?q=QUINT&status=active', tenant.ownerToken).expect(200);
      expect(idsOf(shouted).sort()).toEqual([byName.id, byEmail.id].sort());

      const none = await call('get', '/users?q=nobody', tenant.ownerToken).expect(200);
      expect((none.body as { data: unknown[] }).data).toEqual([]);

      await call('get', '/users?q=', tenant.ownerToken).expect(400);

      const first = await call('get', '/users?q=quint&limit=1', tenant.ownerToken).expect(200);
      const page = first.body as { data: { id: string }[]; next_cursor: string | null };
      expect(page.data).toHaveLength(1);
      expect(page.next_cursor).not.toBeNull();
      const second = await call('get', `/users?q=quint&limit=1&cursor=${page.next_cursor}`, tenant.ownerToken).expect(200);
      const rest = second.body as { data: { id: string }[]; next_cursor: string | null };
      expect(rest.data).toHaveLength(1);
      expect(rest.next_cursor).toBeNull();
      expect([page.data[0]?.id, rest.data[0]?.id].sort()).toEqual([byName.id, byEmail.id].sort());
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

    it('answers own_account when an owner deactivates themselves, and lets an owner deactivate another owner', async () => {
      const tenant = await freshTenant();
      const own = await call('post', `/users/${tenant.ownerId}/deactivate`, tenant.ownerToken).expect(409);
      expect((own.body as { code: string }).code).toBe('own_account');

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

  describe('privilege', () => {
    it('keeps the owner role out of reach of a non-owner, even for themselves', async () => {
      const tenant = await freshTenant();
      const lead = await leadWith(tenant, ['user.read', 'role.read', 'role.assign']);
      const ownerRole = await roleId(tenant.id, 'owner');

      const response = await call('put', `/users/${lead.id}/roles`, lead.token, {
        role_ids: [lead.roleId, ownerRole],
      }).expect(403);

      expect((response.body as { code: string }).code).toBe('owner_only');
      await expect(roleIdsOf(tenant.id, lead.id)).resolves.toEqual([lead.roleId]);
    });

    it('refuses adding a role with permissions the caller lacks, and names them', async () => {
      const tenant = await freshTenant();
      const lead = await leadWith(tenant, ['user.read', 'role.read', 'role.assign']);
      const person = await createTestUser(prisma, tenant.id, { roles: [] });
      const memberRole = await roleId(tenant.id, 'member');

      const response = await call('put', `/users/${person.id}/roles`, lead.token, { role_ids: [memberRole] }).expect(403);

      const body = response.body as { code: string; permissions: string[] };
      expect(body.code).toBe('exceeds_own_permissions');
      expect(body.permissions).toContain('order.write');
      await expect(roleIdsOf(tenant.id, person.id)).resolves.toEqual([]);
    });

    it("lets the caller add a role they can cover but not take away one they can't", async () => {
      const tenant = await freshTenant();
      const lead = await leadWith(tenant, ['user.read', 'role.read', 'role.assign', 'order.read']);
      const packing = await createRole(tenant, 'Packing', ['order.read']);
      const finance = await createRole(tenant, 'Finance', ['payment.refund']);
      const person = await createTestUser(prisma, tenant.id, { roles: [] });
      await call('put', `/users/${person.id}/roles`, tenant.ownerToken, { role_ids: [finance] }).expect(200);

      await call('put', `/users/${person.id}/roles`, lead.token, { role_ids: [finance, packing] }).expect(200);
      await expect(roleIdsOf(tenant.id, person.id)).resolves.toEqual([finance, packing].sort());

      const response = await call('put', `/users/${person.id}/roles`, lead.token, { role_ids: [packing] }).expect(403);

      expect((response.body as { code: string }).code).toBe('exceeds_own_permissions');
      await expect(roleIdsOf(tenant.id, person.id)).resolves.toEqual([finance, packing].sort());
    });

    it('answers 409 last_owner when the only owner loses the owner role', async () => {
      const tenant = await freshTenant();
      const memberRole = await roleId(tenant.id, 'member');

      const response = await call('put', `/users/${tenant.ownerId}/roles`, tenant.ownerToken, {
        role_ids: [memberRole],
      }).expect(409);

      expect((response.body as { code: string }).code).toBe('last_owner');
    });

    it('refuses deactivating yourself, for an owner and for a lead alike', async () => {
      const tenant = await freshTenant();
      const lead = await leadWith(tenant, ['user.read', 'user.deactivate']);

      const owner = await call('post', `/users/${tenant.ownerId}/deactivate`, tenant.ownerToken).expect(409);
      const self = await call('post', `/users/${lead.id}/deactivate`, lead.token).expect(409);

      expect((owner.body as { code: string }).code).toBe('own_account');
      expect((self.body as { code: string }).code).toBe('own_account');
    });

    it('lets a lead deactivate only people who hold no more than they do, and never an owner', async () => {
      const tenant = await freshTenant();
      const lead = await leadWith(tenant, ['user.read', 'user.deactivate', 'order.read']);
      const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
      const packer = await createTestUser(prisma, tenant.id, { roles: [] });
      const packing = await createRole(tenant, 'Packing', ['order.read']);
      await call('put', `/users/${packer.id}/roles`, tenant.ownerToken, { role_ids: [packing] }).expect(200);
      const secondOwner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });

      const heldMore = await call('post', `/users/${member.id}/deactivate`, lead.token).expect(403);
      expect((heldMore.body as { code: string }).code).toBe('person_holds_more');

      await call('post', `/users/${packer.id}/deactivate`, lead.token).expect(204);

      const ownerOnly = await call('post', `/users/${secondOwner.id}/deactivate`, lead.token).expect(403);
      expect((ownerOnly.body as { code: string }).code).toBe('owner_only');
    });
  });

  describe('reactivate', () => {
    it('reactivates a member who then signs in again with their roles intact, and records it once', async () => {
      const tenant = await freshTenant();
      const member = await createTestUser(prisma, tenant.id, { roles: ['member'], status: 'deactivated' });
      const rolesBefore = await roleIdsOf(tenant.id, member.id);

      await call('post', `/users/${member.id}/reactivate`, tenant.ownerToken).expect(204);

      const active = await call('get', '/users?status=active', tenant.ownerToken).expect(200);
      expect((active.body as { data: { id: string }[] }).data.map((user) => user.id)).toContain(member.id);
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: member.email, password: TEST_PASSWORD, workspace: tenant.slug })
        .expect(200);
      await expect(roleIdsOf(tenant.id, member.id)).resolves.toEqual(rolesBefore);

      await call('post', `/users/${member.id}/reactivate`, tenant.ownerToken).expect(204);

      const entries = await prisma.inTenant(tenant.id, (tx) =>
        tx.auditEntry.findMany({ where: { action: 'user.reactivated', subjectId: member.id } }),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actorId: tenant.ownerId,
        before: { status: 'deactivated' },
        after: { status: 'active' },
      });
      await expect(
        prisma.inTenant(tenant.id, (tx) =>
          tx.notification.count({ where: { eventKey: 'user.reactivated', subjectId: member.id } }),
        ),
      ).resolves.toBe(1);
    });

    it("answers 404 for a customer person's id", async () => {
      const tenant = await freshTenant();
      const person = await createTestUser(prisma, tenant.id, { roles: [], status: 'deactivated' });
      await prisma.inTenant(tenant.id, (tx) => tx.user.update({ where: { id: person.id }, data: { kind: 'customer' } }));

      await call('post', `/users/${person.id}/reactivate`, tenant.ownerToken).expect(404);
    });

    it('refuses a lead reactivating someone who holds more than the lead, or an owner', async () => {
      const tenant = await freshTenant();
      const lead = await leadWith(tenant, ['user.read', 'user.deactivate']);
      const member = await createTestUser(prisma, tenant.id, { roles: ['member'], status: 'deactivated' });
      const secondOwner = await createTestUser(prisma, tenant.id, { roles: ['owner'], status: 'deactivated' });

      const heldMore = await call('post', `/users/${member.id}/reactivate`, lead.token).expect(403);
      const ownerOnly = await call('post', `/users/${secondOwner.id}/reactivate`, lead.token).expect(403);

      expect((heldMore.body as { code: string }).code).toBe('person_holds_more');
      expect((ownerOnly.body as { code: string }).code).toBe('owner_only');
      const statuses = await prisma.inTenant(tenant.id, (tx) =>
        tx.user.findMany({ where: { id: { in: [member.id, secondOwner.id] } }, select: { status: true } }),
      );
      expect(statuses.map((row) => row.status)).toEqual(['deactivated', 'deactivated']);
    });
  });

  describe('roles', () => {
    it('lists roles with their permissions', async () => {
      const tenant = await freshTenant();

      const response = await call('get', '/roles', tenant.ownerToken).expect(200);
      const roles = (response.body as { data: { name: string; is_system: boolean; permissions: string[] }[] }).data;

      expect(roles.map((role) => [role.name, role.is_system])).toEqual([
        ['accountant', true],
        ['member', true],
        ['owner', true],
      ]);
      expect(roles.find((role) => role.name === 'member')?.permissions).toEqual([
        'catalog.read',
        'customer.read',
        'file.read',
        'file.write',
        'order.read',
        'order.write',
        'partner.read',
        'payment.read',
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
