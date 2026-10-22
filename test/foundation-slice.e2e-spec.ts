import { createHash, randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { TENANT_PERMISSIONS } from '../src/modules/identity/permissions';
import { hashPassword } from '../src/modules/identity/passwords';
import { messagesTo, waitForMessage } from './mailpit';
import { putToSignedUrl } from './storage';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface Session {
  access_token: string;
  refresh_token: string;
}

interface FeedEntry {
  id: string;
  event_key: string;
  title: string;
  body: string;
}

/**
 * The foundation's acceptance slice (spec, acceptance steps 1–10) in one run,
 * over HTTP with a real worker, Mailpit and MinIO: from a platform admin
 * creating a tenant to a second tenant seeing none of the first one's work.
 */
describe('foundation slice', () => {
  // Several emails and a measurement go through the worker.
  jest.setTimeout(30_000);

  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  const run = newId().slice(-8);
  const tenantIds: string[] = [];
  let adminId: string | undefined;

  async function call(
    method: 'get' | 'post' | 'put',
    path: string,
    options: { token?: string; body?: object; host?: string } = {},
  ): Promise<request.Response> {
    let pending = request(app.getHttpServer())[method](path);
    if (options.token) pending = pending.set('Authorization', `Bearer ${options.token}`);
    if (options.host) pending = pending.set('Host', options.host);
    return options.body ? pending.send(options.body) : pending;
  }

  async function provision(adminToken: string, suffix: string): Promise<{ id: string; slug: string; ownerEmail: string }> {
    const slug = `fs-${run}-${suffix}`;
    const ownerEmail = `fs-owner-${suffix}-${run}@example.test`;
    const response = await call('post', '/platform/tenants', {
      token: adminToken,
      body: { name: `Foundation ${suffix}`, slug, currency: 'EUR', locale: 'en', timezone: 'UTC', ownerEmail },
    });
    expect(response.status).toBe(201);
    const id = (response.body as { id: string }).id;
    tenantIds.push(id);
    return { id, slug, ownerEmail };
  }

  /** Accepts the emailed invitation with the link's token. */
  async function accept(email: string, name: string, password: string): Promise<void> {
    const message = await waitForMessage(email);
    const match = /#token=([^\s]+)/.exec(message.text);
    expect(match).not.toBeNull();
    const token = decodeURIComponent(match?.[1] ?? '');
    expect((await call('post', '/auth/invitations/accept', { body: { token, name, password } })).status).toBe(204);
  }

  /** Logs in at the tenant's own subdomain (F5). */
  async function login(email: string, password: string, slug: string): Promise<Session> {
    const response = await call('post', '/auth/login', { body: { email, password }, host: `${slug}.localhost:3000` });
    expect(response.status).toBe(200);
    return response.body as Session;
  }

  const feed = async (token: string) =>
    ((await call('get', '/notifications', { token })).body as { data: FeedEntry[] }).data;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);

    worker = await startTestWorker();
  });

  afterAll(async () => {
    await worker?.close();
    await prisma?.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    if (adminId) await prisma.platformAdmin.delete({ where: { id: adminId } });
    await app?.close();
  });

  it('runs the ten acceptance steps end to end', async () => {
    // 1. A platform admin creates a tenant.
    const adminEmail = `fs-admin-${run}@example.test`;
    const admin = await prisma.platformAdmin.create({
      data: { email: adminEmail, passwordHash: await hashPassword('foundation-admin-pw'), name: 'Foundation Admin' },
    });
    adminId = admin.id;
    const adminLogin = await call('post', '/platform/auth/login', {
      body: { email: adminEmail, password: 'foundation-admin-pw' },
    });
    expect(adminLogin.status).toBe(200);
    const adminToken = (adminLogin.body as { access_token: string }).access_token;
    const a = await provision(adminToken, 'a');

    // 2. The owner accepts the emailed invitation.
    const ownerPassword = 'owner-password-123';
    await accept(a.ownerEmail, 'Owner', ownerPassword);

    // 3. The owner logs in at the subdomain, refreshes, and reads /me with every tenant permission.
    const first = await login(a.ownerEmail, ownerPassword, a.slug);
    const refreshed = await call('post', '/auth/refresh', { body: { refresh_token: first.refresh_token } });
    expect(refreshed.status).toBe(200);
    const second = refreshed.body as Session;
    const me = await call('get', '/me', { token: second.access_token });
    expect(me.status).toBe(200);
    expect((me.body as { permissions: string[] }).permissions).toEqual([...TENANT_PERMISSIONS].sort());

    // 4. The rotated refresh token is refused, and the whole chain with it.
    expect((await call('post', '/auth/refresh', { body: { refresh_token: first.refresh_token } })).status).toBe(401);
    expect((await call('post', '/auth/refresh', { body: { refresh_token: second.refresh_token } })).status).toBe(401);
    const owner = second.access_token;

    // 5. The owner writes a setting and reads it back.
    const sender = { name: 'Foundation Ops', email: 'ops@example.test' };
    expect((await call('put', '/settings/notification.sender', { token: owner, body: sender })).status).toBe(200);
    expect((await call('get', '/settings', { token: owner })).body).toEqual({ data: { 'notification.sender': sender } });

    // 6. The owner overrides the file.measured wording and previews it.
    const override = { subject: 'Ready to print: {{ file_name }}', body: 'We checked it. {{ measures }}', enabled: true };
    expect((await call('put', '/notification-templates/file.measured/en', { token: owner, body: override })).status).toBe(200);
    const preview = await call('post', '/notification-templates/preview', {
      token: owner,
      body: { event_key: 'file.measured', locale: 'en', subject: override.subject, body: override.body },
    });
    expect(preview.status).toBe(200);
    expect((preview.body as { subject: string }).subject).toBe('Ready to print: poster-a2.pdf');

    // 7. The owner starts an upload, PUTs the bytes to MinIO, completes, and measurement runs.
    const bytes = Buffer.from(`%PDF-1.7 foundation slice ${run}`);
    const started = await call('post', '/files', {
      token: owner,
      body: { kind: 'design', name: 'poster.pdf', content_type: 'application/pdf', size: bytes.length, declared_unit: 'mm' },
    });
    expect(started.status).toBe(201);
    const { file, version, upload } = started.body as {
      file: { id: string };
      version: { id: string };
      upload: { url: string; headers: Record<string, string> };
    };
    const put = await putToSignedUrl(upload.url, bytes, upload.headers);
    await put.arrayBuffer();
    expect(put.status).toBe(200);
    expect((await call('post', `/files/${file.id}/versions/${version.id}/complete`, { token: owner })).status).toBe(200);

    const measured = await waitFor(async () => {
      const shown = (await call('get', `/files/${file.id}`, { token: owner })).body as {
        versions: { id: string; status: string; checksum: string | null }[];
      };
      return shown.versions[0]?.status === 'measured' ? shown.versions[0] : undefined;
    }, 15_000);
    expect(measured.checksum).toBe(createHash('sha256').update(bytes).digest('hex'));

    const link = await call('get', `/files/${file.id}/versions/${version.id}/url`, { token: owner });
    expect(link.status).toBe(200);
    const download = await fetch((link.body as { url: string }).url);
    expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);

    // 8. file.measured arrives in Mailpit and in the feed, with the override's wording.
    const ready = await waitFor(async () => {
      const messages = await messagesTo(a.ownerEmail);
      return messages.find((message) => message.Subject === 'Ready to print: poster.pdf');
    }, 15_000);
    expect(ready).toBeDefined();
    const entry = await waitFor(async () => (await feed(owner)).find((item) => item.event_key === 'file.measured'));
    expect(entry.title).toBe('Ready to print: poster.pdf');
    expect(entry.body).toBe('We checked it. no measures for this type');

    // 9. A role change writes an audit entry.
    const colleagueEmail = `fs-colleague-${run}@example.test`;
    const roles = (await call('get', '/roles', { token: owner })).body as { data: { id: string; name: string }[] };
    const memberRoleId = roles.data.find((role) => role.name === 'member')?.id ?? '';
    const ownerRoleId = roles.data.find((role) => role.name === 'owner')?.id ?? '';
    expect((await call('post', '/users/invitations', {
      token: owner,
      body: { email: colleagueEmail, role_id: memberRoleId },
    })).status).toBe(201);
    await accept(colleagueEmail, 'Colleague', 'colleague-password-123');
    const users = (await call('get', '/users', { token: owner })).body as { data: { id: string; email: string }[] };
    const colleagueId = users.data.find((user) => user.email === colleagueEmail)?.id ?? '';
    expect((await call('put', `/users/${colleagueId}/roles`, {
      token: owner,
      body: { role_ids: [memberRoleId, ownerRoleId] },
    })).status).toBe(200);
    const audited = await prisma.inTenant(a.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'user.roles_changed', subjectId: colleagueId } }),
    );
    expect(audited).toHaveLength(1);

    // 10. A second tenant sees none of it.
    const b = await provision(adminToken, 'b');
    await accept(b.ownerEmail, 'Bowner', 'bowner-password-123');
    const ownerB = (await login(b.ownerEmail, 'bowner-password-123', b.slug)).access_token;

    expect((await call('get', `/files/${file.id}`, { token: ownerB })).status).toBe(404);
    expect((await call('get', `/files/${file.id}/versions/${version.id}/url`, { token: ownerB })).status).toBe(404);
    const templatesB = (await call('get', '/notification-templates', { token: ownerB })).body as {
      data: { overrides: unknown[] }[];
    };
    expect(templatesB.data.every((template) => template.overrides.length === 0)).toBe(true);
    expect((await call('get', '/settings', { token: ownerB })).body).toEqual({ data: {} });
    expect(await feed(ownerB)).toEqual([]);
    expect(await prisma.inTenant(b.id, (tx) => tx.file.count())).toBe(0);
  });
});
