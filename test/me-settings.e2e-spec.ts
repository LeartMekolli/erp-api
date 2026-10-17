import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { TENANT_PERMISSIONS } from '../src/modules/identity/permissions';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

describe('current identity and settings', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let tenant: { id: string; slug: string };
  let other: { id: string; slug: string };
  let owner: { id: string; email: string };
  let ownerToken: string;
  let memberToken: string;
  let otherOwnerToken: string;
  let platformToken: string;
  let platformAdminId: string;

  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
  const put = (path: string, token: string, body: unknown) =>
    request(app.getHttpServer()).put(path).set('Authorization', `Bearer ${token}`).send(body as object);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);

    tenant = await createTestTenant(prisma);
    other = await createTestTenant(prisma);
    owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const otherOwner = await createTestUser(prisma, other.id, { roles: ['owner'] });
    ownerToken = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    memberToken = (await tokens.issueForUser(tenant.id, member.id)).accessToken;
    otherOwnerToken = (await tokens.issueForUser(other.id, otherOwner.id)).accessToken;

    const admin = await prisma.platformAdmin.create({
      data: { email: `me-${newId()}@example.test`, passwordHash: 'x', name: 'Me Admin' },
    });
    platformAdminId = admin.id;
    platformToken = (await tokens.issueForPlatformAdmin(admin.id)).accessToken;
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, [tenant.id, other.id]);
    await prisma.platformAdmin.delete({ where: { id: platformAdminId } });
    await app.close();
  });

  describe('GET /me', () => {
    it('returns the user, roles, permissions and memberships, and no hash', async () => {
      const organisationId = newId();
      await prisma.inTenant(tenant.id, (tx) =>
        tx.organisationMembership.create({
          data: { userId: owner.id, organisationType: 'partner', organisationId, role: 'operator' },
        }),
      );

      const response = await get('/me', ownerToken).expect(200);
      const body = response.body as {
        user: Record<string, unknown>;
        roles: { id: string; name: string }[];
        permissions: string[];
        memberships: unknown[];
      };

      expect(body.user).toMatchObject({ id: owner.id, email: owner.email, status: 'active' });
      expect(Object.keys(body.user).sort()).toEqual(['created_at', 'email', 'id', 'locale', 'name', 'status']);
      expect(body.roles.map((role) => role.name)).toEqual(['owner']);
      expect(body.permissions).toEqual([...TENANT_PERMISSIONS].sort());
      expect(body.memberships).toEqual([
        { organisation_type: 'partner', organisation_id: organisationId, role: 'operator' },
      ]);
    });

    it('refuses a platform token', async () => {
      await get('/me', platformToken).expect(403);
    });

    it('offers no way to look a user up by email', async () => {
      const response = await get(`/users?email=${encodeURIComponent(owner.email)}`, ownerToken).expect(200);

      // The unknown query key is dropped, not applied as a filter.
      expect((response.body as { data: unknown[] }).data.length).toBeGreaterThan(1);
      await get(`/users/by-email/${encodeURIComponent(owner.email)}`, ownerToken).expect(404);
    });
  });

  describe('settings', () => {
    const sender = { name: 'Ops', email: 'ops@example.test' };

    it('lets an owner write a setting and read it back', async () => {
      await put('/settings/notification.sender', ownerToken, sender).expect(200, sender);

      const response = await get('/settings', ownerToken).expect(200);
      expect(response.body).toEqual({ data: { 'notification.sender': sender } });
    });

    it('lets a member read but not write', async () => {
      await get('/settings', memberToken).expect(200);
      await put('/settings/notification.sender', memberToken, sender).expect(403);
    });

    it('keeps settings per tenant', async () => {
      await put('/settings/notification.sender', ownerToken, sender).expect(200);

      await get('/settings', otherOwnerToken).expect(200, { data: {} });
    });

    it('refuses an unknown key and an invalid value', async () => {
      await put('/settings/made.up', ownerToken, {}).expect(400);

      const invalid = await put('/settings/business.calendar', ownerToken, {
        workingDays: [1, 2, 3],
        startHour: 17,
        endHour: 9,
      }).expect(400);
      expect((invalid.body as { errors: { path: string }[] }).errors.map((error) => error.path)).toContain('endHour');
    });
  });
});
