import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { hashPassword } from '../src/modules/identity/passwords';
import { TENANT_PERMISSIONS } from '../src/modules/identity/permissions';
import { sessionTokensSchema } from '../src/modules/auth/session.service';
import type { SessionTokens as Session } from '../src/modules/auth/session.service';
import { tenantResponseSchema } from '../src/platform/tenant.service';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const ADMIN_PASSWORD = 'platform-admin-password';

describe('platform', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AuditService;
  let tokens: AccessTokenService;
  const notifier = new CapturingIdentityNotifier();
  const adminEmail = `platform-${newId()}@example.test`;
  let adminId: string;
  let adminToken: string;
  const createdTenants: string[] = [];
  const createdAdmins: string[] = [];
  const run = newId().slice(-8);

  const tenantBody = (suffix: string) => ({
    name: `Platform ${suffix}`,
    slug: `p-${run}-${suffix}`,
    currency: 'EUR',
    locale: 'en',
    timezone: 'UTC',
    ownerEmail: `Owner.${suffix}@Example.TEST`,
  });

  const post = (path: string, token?: string) => {
    const call = request(app.getHttpServer()).post(`/platform/${path}`);
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };
  const get = (path: string, token?: string) => {
    const call = request(app.getHttpServer()).get(`/platform/${path}`);
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };

  async function createTenant(suffix: string): Promise<string> {
    const response = await post('tenants', adminToken).send(tenantBody(suffix)).expect(201);
    const id = (response.body as { id: string }).id;
    createdTenants.push(id);
    return id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_NOTIFIER)
      .useValue(notifier)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    audit = moduleRef.get(AuditService);
    tokens = moduleRef.get(AccessTokenService);

    const admin = await prisma.platformAdmin.create({
      data: { email: adminEmail, passwordHash: await hashPassword(ADMIN_PASSWORD), name: 'Platform Admin' },
    });
    adminId = admin.id;
    adminToken = (await tokens.issueForPlatformAdmin(admin.id)).accessToken;
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    // Their refresh tokens go with them.
    await prisma.platformAdmin.deleteMany({ where: { id: { in: [adminId, ...createdAdmins] } } });
    await app.close();
  });

  describe('login', () => {
    it('returns an access token and a refresh token for the right password', async () => {
      const response = await post('auth/login')
        .send({ email: adminEmail.toUpperCase(), password: ADMIN_PASSWORD })
        .expect(200);

      expectDocumented(sessionTokensSchema, response.body);
      await get('tenants?limit=1', (response.body as Session).access_token).expect(200);
    });

    it('answers a wrong password and an unknown email identically', async () => {
      const wrong = await post('auth/login').send({ email: adminEmail, password: 'not-the-password' });
      const unknown = await post('auth/login').send({
        email: `nobody-${newId()}@example.test`,
        password: 'not-the-password',
      });

      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(unknown.body).toEqual(wrong.body);
    });
  });

  describe('staying logged in', () => {
    const login = async (email = adminEmail, password = ADMIN_PASSWORD) =>
      (await post('auth/login').send({ email, password }).expect(200)).body as Session;
    const refresh = (refreshToken: string) => post('auth/refresh').send({ refresh_token: refreshToken });

    /** A platform admin of this test's own, so revoking its sessions touches no other test. */
    async function ownAdmin(): Promise<{ id: string; email: string }> {
      const email = `platform-${newId()}@example.test`;
      const admin = await prisma.platformAdmin.create({
        data: { email, passwordHash: await hashPassword(ADMIN_PASSWORD), name: 'Platform Admin' },
      });
      createdAdmins.push(admin.id);
      return { id: admin.id, email };
    }

    it('rotates the refresh token, within one session of 12 hours from login', async () => {
      const admin = await ownAdmin();
      const first = await login(admin.email);

      const renewed = await refresh(first.refresh_token).expect(200);
      expectDocumented(sessionTokensSchema, renewed.body);
      const second = renewed.body as Session;
      expect(second.refresh_token).not.toBe(first.refresh_token);
      await get('tenants?limit=1', second.access_token).expect(200);

      // Rotating never lengthens the session: every token of it ends when the first one does.
      const rows = await prisma.platformRefreshToken.findMany({ where: { platformAdminId: admin.id }, orderBy: { issuedAt: 'asc' } });
      expect(rows).toHaveLength(2);
      expect(rows[1].expiresAt).toEqual(rows[0].expiresAt);
      const hours = (rows[0].expiresAt.getTime() - rows[0].issuedAt.getTime()) / 3_600_000;
      expect(hours).toBeCloseTo(12, 1);
    });

    it('revokes the whole session when a refresh token is used twice', async () => {
      const admin = await ownAdmin();
      const first = await login(admin.email);
      const second = (await refresh(first.refresh_token).expect(200)).body as Session;

      await refresh(first.refresh_token).expect(401);
      // The thief's reuse also ends the session of whoever held the newest token.
      await refresh(second.refresh_token).expect(401);
    });

    it('refuses a session that has ended, an admin no longer active, and tokens it never issued', async () => {
      const admin = await ownAdmin();
      const ended = await login(admin.email);
      await prisma.platformRefreshToken.updateMany({ where: { platformAdminId: admin.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await refresh(ended.refresh_token).expect(401);

      const live = await login(admin.email);
      await prisma.platformAdmin.update({ where: { id: admin.id }, data: { status: 'disabled' } });
      await refresh(live.refresh_token).expect(401);

      await refresh('not-a-token').expect(401);
      await refresh(`platform.${'a'.repeat(43)}`).expect(401);
      // A workspace's refresh token is not a platform one.
      await refresh(`${newId()}.${'a'.repeat(43)}`).expect(401);
    });

    it('logs out: the refresh token and the access token stop working at once', async () => {
      const admin = await ownAdmin();
      const session = await login(admin.email);

      await post('auth/logout', session.access_token).send({ refresh_token: session.refresh_token }).expect(204);

      await refresh(session.refresh_token).expect(401);
      await get('tenants?limit=1', session.access_token).expect(401);
    });
  });

  describe('tenant creation', () => {
    it('provisions system roles, an owner invitation and an audit entry, then notifies', async () => {
      const id = await createTenant('main');
      const ownerEmail = 'owner.main@example.test';

      const state = await prisma.inTenant(id, async (tx) => ({
        roles: await tx.role.findMany({ include: { permissions: true }, orderBy: { name: 'asc' } }),
        invitations: await tx.invitation.findMany(),
        audit: await tx.auditEntry.findMany(),
      }));

      expect(state.roles.map((role) => [role.name, role.isSystem])).toEqual([
        ['accountant', true],
        ['member', true],
        ['owner', true],
      ]);
      const owner = state.roles.find((role) => role.name === 'owner');
      expect(owner?.permissions.map((row) => row.permission).sort()).toEqual([...TENANT_PERMISSIONS].sort());

      expect(state.invitations).toHaveLength(1);
      expect(state.invitations[0]).toMatchObject({ email: ownerEmail, roleId: owner?.id, acceptedAt: null });

      expect(state.audit).toHaveLength(1);
      expect(state.audit[0]).toMatchObject({
        action: 'tenant.created',
        actorType: 'platform_admin',
        actorId: adminId,
        subjectId: id,
      });

      const notice = notifier.lastInvitationFor(ownerEmail);
      expect(notice).toMatchObject({ tenantId: id, invitationId: state.invitations[0]?.id });
      expect(notice?.token.startsWith(`${id}.`)).toBe(true);
    });

    it('leaves nothing behind and sends nothing when provisioning fails midway', async () => {
      const sentBefore = notifier.invitations.length;
      const spy = jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('boom'));

      await post('tenants', adminToken).send(tenantBody('broken')).expect(500);
      spy.mockRestore();

      await expect(prisma.tenant.count({ where: { slug: `p-${run}-broken` } })).resolves.toBe(0);
      expect(notifier.invitations).toHaveLength(sentBefore);
    });

    it('refuses a duplicate slug with 409', async () => {
      await createTenant('dup');

      await post('tenants', adminToken).send(tenantBody('dup')).expect(409);
    });

    it('refuses invalid input with field errors', async () => {
      const response = await post('tenants', adminToken)
        .send({ ...tenantBody('bad'), slug: 'www', ownerEmail: 'not-an-email' })
        .expect(400);

      const paths = (response.body as { errors: { path: string }[] }).errors.map((error) => error.path);
      expect(paths).toEqual(expect.arrayContaining(['slug', 'ownerEmail']));
    });
  });

  describe('listing', () => {
    it('pages newest first with a cursor and filters by status', async () => {
      const ids = [await createTenant('l1'), await createTenant('l2'), await createTenant('l3')];
      const seen: string[] = [];
      let cursor: string | null = null;

      // Other suites create tenants concurrently, so page until ours are found.
      do {
        const query: string = cursor ? `tenants?limit=2&cursor=${cursor}` : 'tenants?limit=2';
        const response = await get(query, adminToken).expect(200);
        const page = response.body as { data: { id: string }[]; next_cursor: string | null };
        expect(page.data.length).toBeLessThanOrEqual(2);
        seen.push(...page.data.map((tenant) => tenant.id));
        cursor = page.next_cursor;
      } while (cursor && !ids.every((id) => seen.includes(id)));

      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort().reverse()).toEqual(seen);
      expect(seen).toEqual(expect.arrayContaining(ids));

      await post(`tenants/${ids[0]}/suspend`, adminToken).expect(204);
      const suspended = await get('tenants?status=suspended&limit=200', adminToken).expect(200);
      const active = await get('tenants?status=active&limit=200', adminToken).expect(200);
      const idsOf = (body: unknown) => (body as { data: { id: string }[] }).data.map((tenant) => tenant.id);

      expect(idsOf(suspended.body)).toContain(ids[0]);
      expect(idsOf(active.body)).not.toContain(ids[0]);
    });

    it('rejects a tampered cursor', async () => {
      await get('tenants?cursor=abc.def', adminToken).expect(400);
    });
  });

  describe('one tenant', () => {
    it('answers the same view as the list', async () => {
      const id = await createTenant('one');

      const response = await get(`tenants/${id}`, adminToken).expect(200);
      expectDocumented(tenantResponseSchema, response.body);
      const listed = await get('tenants?limit=200', adminToken).expect(200);
      expect(response.body).toEqual((listed.body as { data: { id: string }[] }).data.find((tenant) => tenant.id === id));

      await get(`tenants/${newId()}`, adminToken).expect(404);
      await get('tenants/not-a-uuid', adminToken).expect(400);
    });
  });

  describe('suspension', () => {
    // That a suspended tenant's tokens stop working is the guard's job, covered
    // in auth-guard.e2e-spec.ts; here: the state change and its audit entry.
    it('suspends a tenant and audits the change', async () => {
      const tenant = await createTestTenant(prisma);
      createdTenants.push(tenant.id);

      await post(`tenants/${tenant.id}/suspend`, adminToken).expect(204);

      await expect(prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).resolves.toMatchObject({
        status: 'suspended',
      });
      const entries = await prisma.inTenant(tenant.id, (tx) =>
        tx.auditEntry.findMany({ where: { action: 'tenant.suspended' } }),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actorId: adminId,
        before: { status: 'active' },
        after: { status: 'suspended' },
      });
    });

    it('treats suspending an already suspended tenant as done, without a second entry', async () => {
      const tenant = await createTestTenant(prisma, { status: 'suspended' });
      createdTenants.push(tenant.id);

      await post(`tenants/${tenant.id}/suspend`, adminToken).expect(204);

      await expect(
        prisma.inTenant(tenant.id, (tx) => tx.auditEntry.count({ where: { action: 'tenant.suspended' } })),
      ).resolves.toBe(0);
    });

    it('answers 404 for an unknown tenant and 400 for a malformed id', async () => {
      await post(`tenants/${newId()}/suspend`, adminToken).expect(404);
      await post('tenants/not-a-uuid/suspend', adminToken).expect(400);
    });
  });

  describe('reactivation', () => {
    it('reactivates a suspended tenant and audits the change', async () => {
      const tenant = await createTestTenant(prisma, { status: 'suspended' });
      createdTenants.push(tenant.id);

      await post(`tenants/${tenant.id}/reactivate`, adminToken).expect(204);

      await expect(prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).resolves.toMatchObject({ status: 'active' });
      const entries = await prisma.inTenant(tenant.id, (tx) => tx.auditEntry.findMany({ where: { action: 'tenant.reactivated' } }));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actorId: adminId, before: { status: 'suspended' }, after: { status: 'active' } });
    });

    it('treats reactivating an active tenant as done, without an entry, like suspending', async () => {
      const tenant = await createTestTenant(prisma);
      createdTenants.push(tenant.id);

      await post(`tenants/${tenant.id}/reactivate`, adminToken).expect(204);

      await expect(
        prisma.inTenant(tenant.id, (tx) => tx.auditEntry.count({ where: { action: 'tenant.reactivated' } })),
      ).resolves.toBe(0);
      await post(`tenants/${newId()}/reactivate`, adminToken).expect(404);
      await post('tenants/not-a-uuid/reactivate', adminToken).expect(400);
    });
  });

  describe("resending the owner's invitation", () => {
    it('sends a new link that replaces the old one, and audits it', async () => {
      const id = await createTenant('resend');
      const ownerEmail = 'owner.resend@example.test';
      const first = notifier.lastInvitationFor(ownerEmail)!;

      await post(`tenants/${id}/owner-invitation`, adminToken).expect(204);

      const second = notifier.lastInvitationFor(ownerEmail)!;
      expect(second.tenantId).toBe(id);
      expect(second.token).not.toBe(first.token);
      const invitations = await prisma.inTenant(id, (tx) => tx.invitation.findMany({ orderBy: { createdAt: 'asc' } }));
      expect(invitations).toHaveLength(2);
      // Only the newest link works.
      expect(invitations[0].expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(invitations[1]).toMatchObject({ id: second.invitationId, email: ownerEmail, roleId: invitations[0].roleId, acceptedAt: null });
      const entries = await prisma.inTenant(id, (tx) => tx.auditEntry.findMany({ where: { action: 'tenant.owner_invitation_resent' } }));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actorType: 'platform_admin', actorId: adminId, subjectId: id });
    });

    it('refuses once the owner has accepted, and for a suspended or unknown tenant', async () => {
      const accepted = await createTenant('accepted');
      await prisma.inTenant(accepted, (tx) => tx.invitation.updateMany({ data: { acceptedAt: new Date() } }));
      await post(`tenants/${accepted}/owner-invitation`, adminToken).expect(409);

      const suspended = await createTenant('resend-suspended');
      await post(`tenants/${suspended}/suspend`, adminToken).expect(204);
      await post(`tenants/${suspended}/owner-invitation`, adminToken).expect(409);

      await post(`tenants/${newId()}/owner-invitation`, adminToken).expect(404);
      await post('tenants/not-a-uuid/owner-invitation', adminToken).expect(400);
    });
  });

  describe('access', () => {
    it('refuses tenant tokens and missing tokens on platform routes', async () => {
      const tenant = await createTestTenant(prisma);
      createdTenants.push(tenant.id);
      const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
      const { accessToken } = await tokens.issueForUser(tenant.id, owner.id);

      await get('tenants', accessToken).expect(403);
      await post('tenants', accessToken).send(tenantBody('nope')).expect(403);
      await get('tenants').expect(401);
    });
  });
});
