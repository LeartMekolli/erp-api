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
import { CapturingIdentityNotifier } from './capturing-notifier';
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
    await prisma.platformAdmin.delete({ where: { id: adminId } });
    await app.close();
  });

  describe('login', () => {
    it('returns an access token for the right password', async () => {
      const response = await post('auth/login')
        .send({ email: adminEmail.toUpperCase(), password: ADMIN_PASSWORD })
        .expect(200);

      expect(response.body).toEqual({ access_token: expect.any(String), expires_at: expect.any(String) });
      await get('tenants?limit=1', (response.body as { access_token: string }).access_token).expect(200);
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
