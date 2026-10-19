import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { LOG_DESTINATION } from '../src/common/logging/logging.module';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { waitForMessage } from './mailpit';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

/**
 * Identity emails end to end, with no stand-in notifier: the API raises, the
 * worker sends through Mailpit, and the test acts on the link it receives.
 */
describe('identity emails', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  const lines: string[] = [];
  const capture = { write: (line: string) => lines.push(line) };
  const previousLevel = process.env.LOG_LEVEL;

  const http = () => request(app.getHttpServer());
  const authed = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** The token in an emailed link, `...#token=<token>`. */
  function tokenIn(text: string): string {
    const match = /#token=([^\s]+)/.exec(text);
    if (!match) {
      throw new Error(`No link in email: ${text}`);
    }
    return decodeURIComponent(match[1]);
  }

  async function freshTenant(): Promise<{ id: string; slug: string; ownerId: string; ownerEmail: string; ownerToken: string }> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    return {
      ...tenant,
      ownerId: owner.id,
      ownerEmail: owner.email,
      ownerToken: (await tokens.issueForUser(tenant.id, owner.id)).accessToken,
    };
  }

  const roleId = (tenantId: string, name: string) =>
    prisma.inTenant(tenantId, async (tx) => (await tx.role.findFirstOrThrow({ where: { name } })).id);

  const feedOf = async (token: string) =>
    ((await http().get('/notifications').set(authed(token)).expect(200)).body as {
      data: { event_key: string; title: string; body: string }[];
    }).data;

  async function inviteAndAccept(tenant: Awaited<ReturnType<typeof freshTenant>>) {
    const email = `invitee-${newId()}@example.test`;
    await http()
      .post('/users/invitations')
      .set(authed(tenant.ownerToken))
      .send({ email, role_id: await roleId(tenant.id, 'member') })
      .expect(201);

    const message = await waitForMessage(email);
    const token = tokenIn(message.text);
    const password = 'invitee-password-123';
    await http().post('/auth/invitations/accept').send({ token, name: 'Invited Person', password }).expect(204);
    return { email, password, token, message };
  }

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    process.env.LOG_LEVEL = 'info';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOG_DESTINATION)
      .useValue(capture)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);

    worker = await startTestWorker((builder) => builder.overrideProvider(LOG_DESTINATION).useValue(capture));
  });

  afterAll(async () => {
    process.env.LOG_LEVEL = previousLevel;
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app?.close();
  });

  it('an invitation email arrives with a working link', async () => {
    const tenant = await freshTenant();
    const { email, password, message } = await inviteAndAccept(tenant);

    expect(message.subject).toBe(`You are invited to Tenant ${tenant.slug}`);
    expect(message.text).toContain(`http://${tenant.slug}.localhost:5173/accept-invitation#token=`);
    await http().post('/auth/login').send({ email, password, workspace: tenant.slug }).expect(200);
  });

  it('a password reset email arrives and its link resets the password', async () => {
    const tenant = await freshTenant();
    const user = await createTestUser(prisma, tenant.id);

    await http().post('/auth/password-reset').send({ email: user.email, workspace: tenant.slug }).expect(202);
    const message = await waitForMessage(user.email);
    expect(message.subject).toBe(`Reset your Tenant ${tenant.slug} password`);
    expect(message.text).toContain(`http://${tenant.slug}.localhost:5173/reset-password#token=`);

    const newPassword = 'a-brand-new-password';
    await http().post('/auth/password-reset/confirm').send({ token: tokenIn(message.text), password: newPassword }).expect(204);
    await http().post('/auth/login').send({ email: user.email, password: newPassword, workspace: tenant.slug }).expect(200);
    await http().post('/auth/login').send({ email: user.email, password: user.password, workspace: tenant.slug }).expect(401);
  });

  it('a password reset for a known email answers without waiting for the email to be queued', async () => {
    // "Always 202" hides which emails exist only if a known one answers as fast
    // as an unknown one, so the reset request must not wait on raising.
    const tenant = await freshTenant();
    const user = await createTestUser(prisma, tenant.id);
    let finishRaise: (id: string) => void = () => undefined;
    const raise = jest
      .spyOn(app.get(NotificationsService, { strict: false }), 'raise')
      .mockImplementation(() => new Promise((resolve) => (finishRaise = resolve)));

    try {
      const started = Date.now();
      await http().post('/auth/password-reset').send({ email: user.email, workspace: tenant.slug }).expect(202);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(1500);
      await waitFor(async () => (raise.mock.calls.length === 1 ? true : undefined));
    } finally {
      // Settle the slow raise, so no promise outlives the test.
      finishRaise('done');
      raise.mockRestore();
    }
  });

  it('the invitation token is in no log line, no feed row and no stored notification', async () => {
    const tenant = await freshTenant();
    const { token } = await inviteAndAccept(tenant);
    const secret = token.split('.')[1] ?? token;

    // Sent and wiped, so nothing below can still be waiting to change.
    await waitFor(async () => {
      const pending = await prisma.inTenant(tenant.id, (tx) =>
        tx.notification.count({ where: { eventKey: 'user.invited', secrets: { not: null } } }),
      );
      return pending === 0 ? true : undefined;
    });

    expect(lines.join('\n')).not.toContain(secret);
    const stored = await prisma.inTenant(tenant.id, (tx) =>
      tx.$queryRaw<{ row: string }[]>`
        SELECT n::text AS row FROM notification n
        UNION ALL SELECT r::text FROM notification_recipient r
        UNION ALL SELECT d::text FROM notification_delivery d`,
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.filter((entry) => entry.row.includes(secret))).toEqual([]);
  });

  it('accepting an invitation notifies holders of user.invite in the feed', async () => {
    const tenant = await freshTenant();
    const { email } = await inviteAndAccept(tenant);

    const joined = await waitFor(async () => (await feedOf(tenant.ownerToken)).find((entry) => entry.event_key === 'user.joined'));
    expect(joined.title).toBe('Invited Person joined your workspace');
    expect(joined.body).toContain(email);
    expect((await waitForMessage(tenant.ownerEmail)).subject).toBe('Invited Person joined your workspace');
  });

  it("changing a user's roles notifies that user by email and in the feed", async () => {
    const tenant = await freshTenant();
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const memberToken = (await tokens.issueForUser(tenant.id, member.id)).accessToken;
    const custom = await http()
      .post('/roles')
      .set(authed(tenant.ownerToken))
      .send({ name: 'Packer', permissions: ['user.read'] })
      .expect(201);

    await http()
      .put(`/users/${member.id}/roles`)
      .set(authed(tenant.ownerToken))
      .send({ role_ids: [await roleId(tenant.id, 'member'), (custom.body as { id: string }).id] })
      .expect(200);

    const message = await waitForMessage(member.email);
    expect(message.subject).toBe('Your roles have changed');
    expect(message.text).toContain('Your roles are now: member, Packer.');

    const changed = await waitFor(async () =>
      (await feedOf(memberToken)).find((entry) => entry.event_key === 'user.roles_changed'),
    );
    expect(changed.body).toContain('member, Packer');
  });
});
