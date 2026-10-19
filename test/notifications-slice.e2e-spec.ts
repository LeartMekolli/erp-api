import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { LOG_DESTINATION } from '../src/common/logging/logging.module';
import { PrismaService } from '../src/database/prisma.service';
import { hashPassword } from '../src/modules/identity/passwords';
import { messagesTo, waitForMessage } from './mailpit';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface FeedEntry {
  id: string;
  event_key: string;
  title: string;
  body: string;
  read_at: string | null;
}

/**
 * Plan 3a's part of the spec's acceptance slice (steps 6, 8 and 10), over
 * HTTP with a real worker and Mailpit: templates, idempotent invitations,
 * emails, the feed and tenant isolation. Every response body and log line is
 * kept and checked at the end for invitation tokens.
 */
describe('notifications slice', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  const run = newId().slice(-8);
  const recorded: string[] = [];
  const lines: string[] = [];
  const capture = { write: (line: string) => lines.push(line) };
  const invitationTokens: string[] = [];
  const tenantIds: string[] = [];
  let adminId: string;
  const previousLevel = process.env.LOG_LEVEL;

  async function call(
    method: 'get' | 'post' | 'put',
    path: string,
    options: { token?: string; body?: object; headers?: Record<string, string> } = {},
  ): Promise<request.Response> {
    let pending = request(app.getHttpServer())[method](path);
    if (options.token) pending = pending.set('Authorization', `Bearer ${options.token}`);
    for (const [name, value] of Object.entries(options.headers ?? {})) pending = pending.set(name, value);
    const response = await (options.body ? pending.send(options.body) : pending);
    recorded.push(JSON.stringify(response.body ?? null));
    return response;
  }

  /** The token in an emailed link, `...#token=<token>`, remembered for the final check. */
  function tokenIn(text: string): string {
    const match = /#token=([^\s]+)/.exec(text);
    if (!match) throw new Error(`No link in email: ${text}`);
    const token = decodeURIComponent(match[1]);
    invitationTokens.push(token);
    return token;
  }

  async function acceptAndLogin(email: string, slug: string, name: string): Promise<string> {
    const message = await waitForMessage(email);
    const password = `${name.toLowerCase()}-password-123`;
    expect((await call('post', '/auth/invitations/accept', { body: { token: tokenIn(message.text), name, password } })).status).toBe(204);
    const login = await call('post', '/auth/login', { body: { email, password, workspace: slug } });
    expect(login.status).toBe(200);
    return (login.body as { access_token: string }).access_token;
  }

  async function provision(adminToken: string, suffix: string) {
    const slug = `ns-${run}-${suffix}`;
    const ownerEmail = `owner-${suffix}-${run}@example.test`;
    const response = await call('post', '/platform/tenants', {
      token: adminToken,
      body: { name: `Slice ${suffix}`, slug, currency: 'EUR', locale: 'en', timezone: 'UTC', ownerEmail },
    });
    expect(response.status).toBe(201);
    const id = (response.body as { id: string }).id;
    tenantIds.push(id);
    return { id, slug, ownerEmail };
  }

  const feed = async (token: string) =>
    ((await call('get', '/notifications', { token })).body as { data: FeedEntry[] }).data;

  /** Waits until the worker has dispatched every notification of a tenant. */
  const settled = (tenantId: string) =>
    waitFor(async () => {
      const open = await prisma.inTenant(tenantId, (tx) =>
        tx.notification.count({ where: { status: { not: 'dispatched' } } }),
      );
      return open === 0 ? true : undefined;
    });

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

    worker = await startTestWorker((builder) => builder.overrideProvider(LOG_DESTINATION).useValue(capture));
  });

  afterAll(async () => {
    process.env.LOG_LEVEL = previousLevel;
    await worker?.close();
    await prisma?.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    if (adminId) await prisma.platformAdmin.delete({ where: { id: adminId } });
    await app?.close();
  });

  it('templates, idempotent invitations, emails, the feed and isolation, end to end', async () => {
    // 1. A platform admin creates tenant A; its owner accepts the emailed invitation.
    const adminEmail = `ns-admin-${run}@example.test`;
    const admin = await prisma.platformAdmin.create({
      data: { email: adminEmail, passwordHash: await hashPassword('slice-admin-password'), name: 'Slice Admin' },
    });
    adminId = admin.id;
    const adminLogin = await call('post', '/platform/auth/login', { body: { email: adminEmail, password: 'slice-admin-password' } });
    const adminToken = (adminLogin.body as { access_token: string }).access_token;

    const a = await provision(adminToken, 'a');
    const ownerA = await acceptAndLogin(a.ownerEmail, a.slug, 'Owner');

    // Joining notifies the people who can invite users, never the person who joined.
    await settled(a.id);
    expect(await feed(ownerA)).toEqual([]);

    // 2. The owner words the invitation email and previews it (acceptance 6).
    const override = { subject: 'Welcome aboard {{ tenant_name }}', body: 'Join the team here:\n\n{{ link }}', enabled: true };
    expect((await call('put', '/notification-templates/user.invited/en', { token: ownerA, body: override })).status).toBe(200);
    const preview = await call('post', '/notification-templates/preview', {
      token: ownerA,
      body: { event_key: 'user.invited', locale: 'en', subject: override.subject, body: override.body },
    });
    expect(preview.status).toBe(200);
    expect((preview.body as { subject: string }).subject).toBe('Welcome aboard Acme Print');

    // 3. Inviting a member twice with one Idempotency-Key: one invitation, one email.
    const memberEmail = `member-${run}@example.test`;
    const roles = (await call('get', '/roles', { token: ownerA })).body as { data: { id: string; name: string }[] };
    const memberRoleId = roles.data.find((role) => role.name === 'member')?.id ?? '';
    const invite = () =>
      call('post', '/users/invitations', {
        token: ownerA,
        body: { email: memberEmail, role_id: memberRoleId },
        headers: { 'Idempotency-Key': `invite-${run}` },
      });
    const first = await invite();
    const second = await invite();
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);

    const invitation = await waitForMessage(memberEmail);
    expect(invitation.subject).toBe(`Welcome aboard Slice a`);
    expect(invitation.text).toContain('Join the team here:');
    expect(await prisma.inTenant(a.id, (tx) => tx.invitation.count({ where: { email: memberEmail } }))).toBe(1);

    // 4. The member accepts from the email's link; the owner's feed shows them joining.
    const memberA = await acceptAndLogin(memberEmail, a.slug, 'Member');
    const joined = await waitFor(async () => (await feed(ownerA)).find((entry) => entry.event_key === 'user.joined'));
    expect(joined.title).toBe('Member joined your workspace');

    // 5. A role change reaches the member by email and in the feed, which they mark read (acceptance 8).
    const packer = await call('post', '/roles', { token: ownerA, body: { name: 'Packer', permissions: ['user.read'] } });
    const memberUser = (await call('get', '/me', { token: memberA })).body as { user: { id: string } };
    const changed = await call('put', `/users/${memberUser.user.id}/roles`, {
      token: ownerA,
      body: { role_ids: [memberRoleId, (packer.body as { id: string }).id] },
    });
    expect(changed.status).toBe(200);

    const rolesEmail = await waitFor(async () => {
      const messages = await messagesTo(memberEmail);
      return messages.find((message) => message.Subject === 'Your roles have changed');
    });
    expect(rolesEmail).toBeDefined();

    const entry = await waitFor(async () => (await feed(memberA)).find((item) => item.event_key === 'user.roles_changed'));
    expect(entry.body).toContain('member, Packer');
    expect((await call('post', `/notifications/${entry.id}/read`, { token: memberA })).status).toBe(204);
    expect((await feed(memberA)).find((item) => item.id === entry.id)?.read_at).toEqual(expect.any(String));

    // 6. Tenant B sees none of it (acceptance 10).
    const b = await provision(adminToken, 'b');
    const ownerB = await acceptAndLogin(b.ownerEmail, b.slug, 'Bowner');
    await settled(b.id);
    const templatesB = (await call('get', '/notification-templates', { token: ownerB })).body as {
      data: { overrides: unknown[] }[];
    };
    expect(templatesB.data.every((template) => template.overrides.length === 0)).toBe(true);
    expect(await feed(ownerB)).toEqual([]);
    expect((await call('post', `/notifications/${entry.id}/read`, { token: ownerB })).status).toBe(404);

    // 7. Nothing was dead-lettered.
    await settled(a.id);
    for (const queue of ['notifications', 'maintenance']) {
      const failed = await call('get', `/platform/jobs/failed?queue=${queue}`, { token: adminToken });
      expect((failed.body as { data: unknown[] }).data).toEqual([]);
    }

    // Finally: no invitation token in any response, stored notification or log line.
    expect(invitationTokens).toHaveLength(3);
    const stored = (
      await Promise.all(
        tenantIds.map((tenantId) =>
          prisma.inTenant(tenantId, (tx) =>
            tx.$queryRaw<{ row: string }[]>`
              SELECT n::text AS row FROM notification n
              UNION ALL SELECT r::text FROM notification_recipient r
              UNION ALL SELECT d::text FROM notification_delivery d`,
          ),
        ),
      )
    ).flat();
    for (const token of invitationTokens) {
      const secret = token.split('.')[1] ?? token;
      expect(recorded.filter((body) => body.includes(secret))).toEqual([]);
      expect(stored.filter((entry) => entry.row.includes(secret))).toEqual([]);
      expect(lines.filter((line) => line.includes(secret))).toEqual([]);
    }
  });
});
