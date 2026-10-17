import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { parseOpaqueToken } from '../src/modules/identity/opaque-token';
import { RedisService } from '../src/redis/redis.service';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { TEST_PASSWORD, createTestTenant, createTestUser, deleteTestTenants } from './factories';

const NEW_PASSWORD = 'freshly-reset-password';

describe('password reset', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  const notifier = new CapturingIdentityNotifier();
  let tenant: { id: string; slug: string };

  const requestReset = (email: string, workspace = tenant.slug) =>
    request(app.getHttpServer()).post('/auth/password-reset').send({ email, workspace });

  const confirm = (token: string, password = NEW_PASSWORD) =>
    request(app.getHttpServer()).post('/auth/password-reset/confirm').send({ token, password });

  const login = (email: string, password: string) =>
    request(app.getHttpServer()).post('/auth/login').send({ email, password, workspace: tenant.slug });

  async function resetTokenFor(email: string): Promise<string> {
    await requestReset(email).expect(202);
    const notice = notifier.lastPasswordResetFor(email);
    if (!notice) throw new Error(`no reset captured for ${email}`);
    return notice.token;
  }

  /**
   * Every request here comes from the same loopback address, so the per-IP
   * limit (20 an hour) would otherwise carry over between tests and runs.
   */
  async function clearIpLimits(): Promise<void> {
    const keys = await redis.client.keys('ratelimit:reset-ip:*');
    if (keys.length > 0) await redis.client.del(...keys);
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
    redis = moduleRef.get(RedisService);
    tenant = await createTestTenant(prisma);
  });

  beforeEach(clearIpLimits);

  afterAll(async () => {
    await clearIpLimits();
    await deleteTestTenants(prisma, [tenant.id]);
    await app.close();
  });

  it('answers known and unknown emails identically, and only notifies the known one', async () => {
    const user = await createTestUser(prisma, tenant.id);
    const unknown = `nobody-${newId()}@example.test`;
    const sentBefore = notifier.passwordResets.length;

    const known = await requestReset(user.email).expect(202);
    const missing = await requestReset(unknown).expect(202);
    const noTenant = await requestReset(user.email, 'no-such-tenant').expect(202);

    expect(missing.body).toEqual(known.body);
    expect(noTenant.body).toEqual(known.body);
    expect(notifier.passwordResets).toHaveLength(sentBefore + 1);
    expect(notifier.lastPasswordResetFor(user.email)).toMatchObject({ tenantId: tenant.id, userId: user.id });
  });

  it('does not notify a deactivated user', async () => {
    const user = await createTestUser(prisma, tenant.id, { status: 'deactivated' });

    await requestReset(user.email).expect(202);

    expect(notifier.lastPasswordResetFor(user.email)).toBeUndefined();
  });

  it('sets the new password and signs the user out of every session', async () => {
    const user = await createTestUser(prisma, tenant.id);
    const session = (await login(user.email, TEST_PASSWORD).expect(200)).body as { refresh_token: string };
    const token = await resetTokenFor(user.email);

    await confirm(token).expect(204);

    await login(user.email, TEST_PASSWORD).expect(401);
    await login(user.email, NEW_PASSWORD).expect(200);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: session.refresh_token })
      .expect(401);
  });

  it('uses a reset token only once', async () => {
    const user = await createTestUser(prisma, tenant.id);
    const token = await resetTokenFor(user.email);

    await confirm(token).expect(204);
    const again = await confirm(token, 'another-new-password').expect(400);

    expect((again.body as { detail: string }).detail).toBe('Reset link is invalid or expired');
  });

  it('refuses an expired reset token', async () => {
    const user = await createTestUser(prisma, tenant.id);
    const token = await resetTokenFor(user.email);
    await prisma.inTenant(tenant.id, (tx) =>
      tx.passwordReset.updateMany({
        where: { tokenHash: parseOpaqueToken(token)?.hash },
        data: { expiresAt: new Date(0) },
      }),
    );

    await confirm(token).expect(400);
  });

  it('refuses garbage tokens and short passwords', async () => {
    const user = await createTestUser(prisma, tenant.id);
    const token = await resetTokenFor(user.email);

    await confirm('garbage').expect(400);
    const short = await confirm(token, 'too-short').expect(400);
    expect((short.body as { errors: { path: string }[] }).errors.map((error) => error.path)).toContain('password');
  });

  it('limits requests to 5 an hour per email', async () => {
    const user = await createTestUser(prisma, tenant.id);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await requestReset(user.email).expect(202);
    }

    await requestReset(user.email).expect(429);
  });

  it('limits requests to 20 an hour per address, across emails', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await requestReset(`spray-${newId()}@example.test`).expect(202);
    }

    await requestReset(`spray-${newId()}@example.test`).expect(429);
  });
});
