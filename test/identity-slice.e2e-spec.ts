import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { hashPassword } from '../src/modules/identity/passwords';
import { pageSchema } from '../src/common/pagination/page';
import { TENANT_PERMISSIONS } from '../src/modules/identity/permissions';
import { meResponseSchema } from '../src/modules/users/me.controller';
import { tenantResponseSchema } from '../src/platform/tenant.service';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';

interface Session {
  access_token: string;
  refresh_token: string;
}

interface Recorded {
  label: string;
  body: string;
}

/**
 * Plan 2's part of the spec's acceptance slice, over HTTP only, from a
 * platform admin to two isolated tenants. Every response body is recorded and
 * checked at the end for credentials (spec 4.8). Steps 6-8 of the spec's slice
 * (templates, files, notifications) belong to plan 3.
 */
describe('identity slice', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const notifier = new CapturingIdentityNotifier();
  const recorded: Recorded[] = [];
  const issuedRefreshTokens: string[] = [];
  const run = newId().slice(-8);
  const adminEmail = `slice-admin-${run}@example.test`;
  const adminPassword = 'slice-admin-password';
  const password = 'slice-user-password';
  let adminId: string;
  const tenantIds: string[] = [];

  async function call(
    label: string,
    method: 'get' | 'post' | 'put',
    path: string,
    options: { token?: string; body?: object; host?: string } = {},
  ): Promise<request.Response> {
    let pending = request(app.getHttpServer())[method](path);
    if (options.token) pending = pending.set('Authorization', `Bearer ${options.token}`);
    if (options.host) pending = pending.set('Host', options.host);
    const response = await (options.body ? pending.send(options.body) : pending);
    recorded.push({ label, body: JSON.stringify(response.body ?? null) });
    return response;
  }

  async function provisionTenant(adminToken: string, suffix: string): Promise<{ id: string; slug: string; ownerEmail: string }> {
    const slug = `slice-${run}-${suffix}`;
    const ownerEmail = `owner-${suffix}-${run}@example.test`;
    const response = await call('platform.tenants.create', 'post', '/platform/tenants', {
      token: adminToken,
      body: { name: `Slice ${suffix}`, slug, currency: 'EUR', locale: 'en', timezone: 'UTC', ownerEmail },
    });
    expect(response.status).toBe(201);
    const id = (response.body as { id: string }).id;
    tenantIds.push(id);
    return { id, slug, ownerEmail };
  }

  async function acceptInvitation(email: string, name: string): Promise<void> {
    const token = notifier.lastInvitationFor(email)?.token ?? '';
    expect((await call('auth.invitations.accept', 'post', '/auth/invitations/accept', {
      body: { token, name, password },
    })).status).toBe(204);
  }

  async function login(email: string, slug: string): Promise<Session> {
    const response = await call('auth.login', 'post', '/auth/login', {
      body: { email, password },
      host: `${slug}.localhost:3000`,
    });
    expect(response.status).toBe(200);
    const session = response.body as Session;
    issuedRefreshTokens.push(session.refresh_token);
    return session;
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

    const admin = await prisma.platformAdmin.create({
      data: { email: adminEmail, passwordHash: await hashPassword(adminPassword), name: 'Slice Admin' },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.platformAdmin.delete({ where: { id: adminId } });
    await app.close();
  });

  it('runs from platform admin to two isolated tenants, without leaking a credential', async () => {
    // 1. The platform admin logs in and creates tenant A.
    const adminLogin = await call('platform.login', 'post', '/platform/auth/login', {
      body: { email: adminEmail, password: adminPassword },
    });
    expect(adminLogin.status).toBe(200);
    const adminToken = (adminLogin.body as { access_token: string }).access_token;
    const tenantA = await provisionTenant(adminToken, 'a');
    const tenantList = await call('platform.tenants.list', 'get', '/platform/tenants', { token: adminToken });
    expect(tenantList.status).toBe(200);
    expectDocumented(pageSchema(tenantResponseSchema), tenantList.body);

    // 2. The owner accepts the invitation and logs in at the tenant's subdomain.
    await acceptInvitation(tenantA.ownerEmail, 'Owner A');
    const first = await login(tenantA.ownerEmail, tenantA.slug);

    // 3. Refresh, then /me with every tenant permission.
    const refreshed = await call('auth.refresh', 'post', '/auth/refresh', { body: { refresh_token: first.refresh_token } });
    expect(refreshed.status).toBe(200);
    const second = refreshed.body as Session;
    issuedRefreshTokens.push(second.refresh_token);

    const me = await call('me', 'get', '/me', { token: second.access_token });
    expect(me.status).toBe(200);
    expectDocumented(meResponseSchema, me.body);
    expect((me.body as { permissions: string[] }).permissions).toEqual([...TENANT_PERMISSIONS].sort());

    // 4. Reusing the rotated refresh token is refused and revokes the chain.
    expect((await call('auth.refresh.reuse', 'post', '/auth/refresh', { body: { refresh_token: first.refresh_token } })).status).toBe(401);
    expect((await call('auth.refresh.revoked', 'post', '/auth/refresh', { body: { refresh_token: second.refresh_token } })).status).toBe(401);
    const ownerToken = second.access_token;

    // 5. A tenant setting is written and read back.
    const sender = { name: 'Slice Ops', email: 'ops@example.test' };
    expect((await call('settings.put', 'put', '/settings/notification.sender', { token: ownerToken, body: sender })).status).toBe(200);
    const settings = await call('settings.get', 'get', '/settings', { token: ownerToken });
    expect(settings.body).toEqual({ data: { 'notification.sender': sender } });

    // 6. A custom role is assigned to a second invited user, and audited.
    const role = await call('roles.create', 'post', '/roles', {
      token: ownerToken,
      body: { name: 'Production lead', permissions: ['user.read', 'settings.read'] },
    });
    expect(role.status).toBe(201);
    const roleId = (role.body as { id: string }).id;
    const roles = await call('roles.list', 'get', '/roles', { token: ownerToken });
    const memberRoleId = (roles.body as { data: { id: string; name: string }[] }).data.find(
      (candidate) => candidate.name === 'member',
    )?.id;

    const colleagueEmail = `colleague-${run}@example.test`;
    expect((await call('users.invite', 'post', '/users/invitations', {
      token: ownerToken,
      body: { email: colleagueEmail, role_id: memberRoleId ?? '' },
    })).status).toBe(201);
    await acceptInvitation(colleagueEmail, 'Colleague');

    const users = await call('users.list', 'get', '/users', { token: ownerToken });
    const colleagueId = (users.body as { data: { id: string; email: string }[] }).data.find(
      (user) => user.email === colleagueEmail,
    )?.id;
    expect((await call('users.roles', 'put', `/users/${colleagueId}/roles`, {
      token: ownerToken,
      body: { role_ids: [roleId] },
    })).status).toBe(200);

    const audited = await prisma.inTenant(tenantA.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'user.roles_changed', subjectId: colleagueId } }),
    );
    expect(audited).toHaveLength(1);

    // 7. A second tenant sees none of it.
    const tenantB = await provisionTenant(adminToken, 'b');
    await acceptInvitation(tenantB.ownerEmail, 'Owner B');
    const ownerB = (await login(tenantB.ownerEmail, tenantB.slug)).access_token;

    const usersB = await call('b.users.list', 'get', '/users', { token: ownerB });
    expect((usersB.body as { data: { email: string }[] }).data.map((user) => user.email)).toEqual([tenantB.ownerEmail]);
    expect((await call('b.settings.get', 'get', '/settings', { token: ownerB })).body).toEqual({ data: {} });
    expect((await call('b.users.roles', 'put', `/users/${colleagueId}/roles`, {
      token: ownerB,
      body: { role_ids: [roleId] },
    })).status).toBe(404);

    // Credentials never leave (spec 4.8): no password hash, no stored token
    // hash, and refresh tokens only in the responses that issue them.
    const storedHashes = (
      await Promise.all(
        tenantIds.map((tenantId) =>
          prisma.inTenant(tenantId, async (tx) => [
            ...(await tx.refreshToken.findMany({ select: { tokenHash: true } })),
            ...(await tx.invitation.findMany({ select: { tokenHash: true } })),
            ...(await tx.passwordReset.findMany({ select: { tokenHash: true } })),
          ]),
        ),
      )
    )
      .flat()
      .map((row) => row.tokenHash);
    expect(storedHashes.length).toBeGreaterThan(0);

    for (const { label, body } of recorded) {
      expect({ label, argon2: body.includes('$argon2') }).toEqual({ label, argon2: false });
      for (const hash of storedHashes) {
        expect({ label, leaksHash: body.includes(hash) }).toEqual({ label, leaksHash: false });
      }
      if (label !== 'auth.login' && label !== 'auth.refresh') {
        for (const token of issuedRefreshTokens) {
          expect({ label, leaksRefreshToken: body.includes(token) }).toEqual({ label, leaksRefreshToken: false });
        }
      }
    }
  });
});
