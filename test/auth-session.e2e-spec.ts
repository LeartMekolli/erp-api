import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { LOG_DESTINATION } from '../src/common/logging/logging.module';
import { PrismaService } from '../src/database/prisma.service';
import { sessionTokensSchema } from '../src/modules/auth/session.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { parseOpaqueToken } from '../src/modules/identity/opaque-token';
import { expectDocumented } from './documented';
import { TEST_PASSWORD, createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface SessionTokens {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

describe('auth sessions', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let tenant: { id: string; slug: string };
  const logLines: string[] = [];
  const createdTenants: string[] = [];
  const previousLevel = process.env.LOG_LEVEL;

  const server = () => app.getHttpServer();

  const login = (body: Record<string, string>, host?: string) => {
    const call = request(server()).post('/auth/login');
    return (host ? call.set('Host', host) : call).send(body);
  };

  async function loginAs(email: string, password = TEST_PASSWORD): Promise<SessionTokens> {
    const response = await login({ email, password, workspace: tenant.slug }).expect(200);
    expectDocumented(sessionTokensSchema, response.body);
    return response.body as SessionTokens;
  }

  const refresh = (refreshToken: string) =>
    request(server()).post('/auth/refresh').send({ refresh_token: refreshToken });

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'info';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOG_DESTINATION)
      .useValue({ write: (line: string) => logLines.push(line) })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);

    tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    process.env.LOG_LEVEL = previousLevel;
  });

  describe('login', () => {
    it('logs in by subdomain and by workspace', async () => {
      const user = await createTestUser(prisma, tenant.id);

      const bySubdomain = await login(
        { email: user.email, password: TEST_PASSWORD },
        `${tenant.slug}.localhost:3000`,
      ).expect(200);
      const byWorkspace = await login({ email: user.email, password: TEST_PASSWORD, workspace: tenant.slug }).expect(
        200,
      );

      for (const body of [bySubdomain.body, byWorkspace.body] as SessionTokens[]) {
        expect(body).toEqual({
          access_token: expect.any(String),
          refresh_token: expect.stringMatching(new RegExp(`^${tenant.id}\\.`)),
          expires_at: expect.any(String),
        });
        await expect(tokens.verify(body.access_token)).resolves.toMatchObject({ tid: tenant.id, scope: 'tenant' });
      }
    });

    it('answers every kind of failure with the same 401', async () => {
      const user = await createTestUser(prisma, tenant.id);
      const deactivated = await createTestUser(prisma, tenant.id, { status: 'deactivated' });
      const suspended = await createTestTenant(prisma, { status: 'suspended' });
      createdTenants.push(suspended.id);
      const suspendedUser = await createTestUser(prisma, suspended.id);

      const failures = await Promise.all([
        login({ email: 'nobody@example.test', password: TEST_PASSWORD, workspace: tenant.slug }),
        login({ email: user.email, password: 'wrong-password-1', workspace: tenant.slug }),
        login({ email: deactivated.email, password: TEST_PASSWORD, workspace: tenant.slug }),
        login({ email: user.email, password: TEST_PASSWORD, workspace: 'no-such-tenant' }),
        login({ email: user.email, password: TEST_PASSWORD }),
        login({ email: suspendedUser.email, password: TEST_PASSWORD, workspace: suspended.slug }),
      ]);

      for (const response of failures) {
        expect(response.status).toBe(401);
        expect(response.body).toEqual(failures[0]?.body);
      }
    });

    it('normalises the email', async () => {
      const user = await createTestUser(prisma, tenant.id, { email: 'case.check@example.test' });

      await login({ email: '  Case.Check@Example.TEST ', password: TEST_PASSWORD, workspace: tenant.slug }).expect(200);
      expect(user.email).toBe('case.check@example.test');
    });

    it('locks out after 10 failures, even with the right password', async () => {
      const user = await createTestUser(prisma, tenant.id);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        await login({ email: user.email, password: 'wrong-password-1', workspace: tenant.slug }).expect(401);
      }

      await login({ email: user.email, password: TEST_PASSWORD, workspace: tenant.slug }).expect(429);
    });
  });

  describe('refresh', () => {
    it('rotates: a new working pair, and the old refresh token is refused', async () => {
      const user = await createTestUser(prisma, tenant.id);
      const first = await loginAs(user.email);

      const rotated = (await refresh(first.refresh_token).expect(200)).body as SessionTokens;
      expectDocumented(sessionTokensSchema, rotated);

      expect(rotated.refresh_token).not.toBe(first.refresh_token);
      await expect(tokens.verify(rotated.access_token)).resolves.toMatchObject({ sub: user.id });
      await refresh(rotated.refresh_token).expect(200);
    });

    it('revokes the whole chain when a rotated token is reused, and the revocation sticks', async () => {
      const user = await createTestUser(prisma, tenant.id);
      const first = await loginAs(user.email);
      const second = (await refresh(first.refresh_token).expect(200)).body as SessionTokens;

      await refresh(first.refresh_token).expect(401);
      // Had the revocation been rolled back with the 401, this would succeed.
      await refresh(second.refresh_token).expect(401);

      const entries = await prisma.inTenant(tenant.id, (tx) =>
        tx.auditEntry.findMany({ where: { action: 'auth.refresh_chain_revoked', actorId: user.id } }),
      );
      expect(entries).toHaveLength(1);
    });

    it('lets exactly one of two concurrent refreshes win, and treats the other as reuse', async () => {
      const user = await createTestUser(prisma, tenant.id);
      const first = await loginAs(user.email);

      const [a, b] = await Promise.all([refresh(first.refresh_token), refresh(first.refresh_token)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]);

      const winner = (a.status === 200 ? a.body : b.body) as SessionTokens;
      await refresh(winner.refresh_token).expect(401);
    });

    it('refuses an expired refresh token', async () => {
      const user = await createTestUser(prisma, tenant.id);
      const first = await loginAs(user.email);
      const parsed = parseOpaqueToken(first.refresh_token);

      await prisma.inTenant(tenant.id, (tx) =>
        tx.refreshToken.updateMany({ where: { tokenHash: parsed?.hash }, data: { expiresAt: new Date(0) } }),
      );

      await refresh(first.refresh_token).expect(401);
    });

    it('refuses malformed tokens and tokens whose prefix names another tenant', async () => {
      const user = await createTestUser(prisma, tenant.id);
      const first = await loginAs(user.email);
      const other = await createTestTenant(prisma);
      createdTenants.push(other.id);
      const secret = first.refresh_token.split('.')[1] ?? '';

      await refresh('garbage').expect(401);
      await refresh(`${other.id}.${secret}`).expect(401);
      await request(server()).post('/auth/refresh').send({}).expect(400);
    });

    it("refuses a refresh once the user's tenant is suspended", async () => {
      const own = await createTestTenant(prisma);
      createdTenants.push(own.id);
      const user = await createTestUser(prisma, own.id);
      const session = (
        await login({ email: user.email, password: TEST_PASSWORD, workspace: own.slug }).expect(200)
      ).body as SessionTokens;

      await prisma.tenant.update({ where: { id: own.id }, data: { status: 'suspended' } });

      await refresh(session.refresh_token).expect(401);
    });
  });

  describe('logout', () => {
    it('revokes the refresh token and stops the access token at once', async () => {
      const user = await createTestUser(prisma, tenant.id);
      const session = await loginAs(user.email);
      const logout = () =>
        request(server())
          .post('/auth/logout')
          .set('Authorization', `Bearer ${session.access_token}`)
          .send({ refresh_token: session.refresh_token });

      await logout().expect(204);

      await refresh(session.refresh_token).expect(401);
      await logout().expect(401);
    });

    it('requires a token', async () => {
      await request(server()).post('/auth/logout').send({ refresh_token: 'x' }).expect(401);
    });
  });

  it('leaves no password or token in the logs', async () => {
    const password = 'distinctive-password-for-logs';
    const user = await createTestUser(prisma, tenant.id, { password });
    logLines.length = 0;

    const session = await loginAs(user.email, password);
    const rotated = (await refresh(session.refresh_token).expect(200)).body as SessionTokens;

    const output = logLines.join('');
    expect(output).toContain('/auth/login');
    for (const secret of [password, session.access_token, session.refresh_token, rotated.refresh_token]) {
      expect(output).not.toContain(secret);
    }
  });
});
