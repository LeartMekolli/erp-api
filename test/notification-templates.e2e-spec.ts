import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { EVENTS } from '../src/modules/notifications/catalogue';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface TemplateEntry {
  event_key: string;
  variables: { name: string; required: boolean }[];
  defaults: { locale: string; subject: string; body: string }[];
  overrides: { locale: string; subject: string; body: string; enabled: boolean; updated_at: string }[];
}

interface Problem {
  errors?: { path: string; message: string }[];
}

describe('notification templates', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const invitation = { subject: 'Join {{ tenant_name }} today', body: 'Hello!\n\nAccept: {{ link }}', enabled: true };

  async function freshTenant(): Promise<{ id: string; ownerToken: string; memberToken: string }> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    return {
      id: tenant.id,
      ownerToken: (await tokens.issueForUser(tenant.id, owner.id)).accessToken,
      memberToken: (await tokens.issueForUser(tenant.id, member.id)).accessToken,
    };
  }

  const list = (token: string) =>
    request(app.getHttpServer()).get('/notification-templates').set('Authorization', `Bearer ${token}`);
  const save = (token: string, path: string, body: object) =>
    request(app.getHttpServer()).put(`/notification-templates/${path}`).set('Authorization', `Bearer ${token}`).send(body);
  const preview = (token: string, body: object) =>
    request(app.getHttpServer())
      .post('/notification-templates/preview')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const entryFor = (entries: TemplateEntry[], event: string) => entries.find((entry) => entry.event_key === event);

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

  it('lists every catalogue event with defaults and no overrides', async () => {
    const tenant = await freshTenant();

    const response = await list(tenant.ownerToken).expect(200);
    const entries = (response.body as { data: TemplateEntry[] }).data;

    expect(entries.map((entry) => entry.event_key).sort()).toEqual(Object.keys(EVENTS).sort());
    expect(entryFor(entries, 'user.invited')).toEqual({
      event_key: 'user.invited',
      variables: [
        { name: 'tenant_name', required: false },
        { name: 'link', required: true },
      ],
      defaults: [{ locale: 'en', ...EVENTS['user.invited'].defaults.en }],
      overrides: [],
    });
    // Secret variables appear by name only: never a sample value.
    expect(JSON.stringify(response.body)).not.toContain('token=sample');
  });

  it('owner saves an override, reads it back, and an audit entry records before and after', async () => {
    const tenant = await freshTenant();

    const saved = await save(tenant.ownerToken, 'user.invited/en', invitation).expect(200);
    expect(saved.body).toEqual({
      event_key: 'user.invited',
      locale: 'en',
      subject: invitation.subject,
      body: invitation.body,
      enabled: true,
      updated_at: expect.any(String),
    });

    const changed = { ...invitation, subject: 'Welcome to {{ tenant_name }}' };
    await save(tenant.ownerToken, 'user.invited/en', changed).expect(200);

    const entries = (await list(tenant.ownerToken).expect(200)).body as { data: TemplateEntry[] };
    expect(entryFor(entries.data, 'user.invited')?.overrides).toEqual([
      { locale: 'en', subject: changed.subject, body: changed.body, enabled: true, updated_at: expect.any(String) },
    ]);

    const audits = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'template.override_changed' }, orderBy: { createdAt: 'asc' } }),
    );
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ subjectType: 'notification_template', before: null });
    expect(audits[1]).toMatchObject({
      before: expect.objectContaining({ subject: invitation.subject }),
      after: expect.objectContaining({ subject: changed.subject }),
    });
  });

  it('an override without {{ link }} on user.invited gives 400 on the body, and the preview refuses it too', async () => {
    const tenant = await freshTenant();
    const withoutLink = { subject: 'Join us', body: 'No link here', enabled: true };

    const saved = await save(tenant.ownerToken, 'user.invited/en', withoutLink).expect(400);
    expect((saved.body as Problem).errors?.map((error) => error.path)).toEqual(['body']);

    const previewed = await preview(tenant.ownerToken, { event_key: 'user.invited', locale: 'en', ...withoutLink }).expect(
      400,
    );
    expect((previewed.body as Problem).errors?.map((error) => error.path)).toEqual(['body']);

    const stored = await prisma.inTenant(tenant.id, (tx) => tx.notificationTemplate.count());
    expect(stored).toBe(0);
  });

  it('an unknown variable and an oversize body give 400', async () => {
    const tenant = await freshTenant();

    await save(tenant.ownerToken, 'user.roles_changed/en', { subject: 's', body: 'Hi {{ nope }}', enabled: true }).expect(
      400,
    );
    await save(tenant.ownerToken, 'user.roles_changed/en', {
      subject: 's',
      body: 'x'.repeat(10_001),
      enabled: true,
    }).expect(400);
  });

  it('rejects an unknown event and a malformed locale', async () => {
    const tenant = await freshTenant();

    await save(tenant.ownerToken, 'no.such.event/en', invitation).expect(404);
    await save(tenant.ownerToken, 'user.invited/english', invitation).expect(400);
    await preview(tenant.ownerToken, { event_key: 'no.such.event', locale: 'en', subject: 's', body: 'b' }).expect(400);
  });

  it('preview renders the samples and escapes HTML', async () => {
    const tenant = await freshTenant();

    const response = await preview(tenant.ownerToken, {
      event_key: 'user.roles_changed',
      locale: 'en',
      subject: 'Hi {{ user_name }}',
      body: '<b>{{ roles }}</b>',
    }).expect(200);

    expect(response.body).toEqual({
      subject: 'Hi Ada Lovelace',
      text: '<b>owner, member</b>',
      html: expect.stringContaining('&lt;b&gt;owner, member&lt;/b&gt;'),
    });
    expect((response.body as { html: string }).html).not.toContain('<b>');
  });

  it('member reads but cannot save or preview', async () => {
    const tenant = await freshTenant();

    await list(tenant.memberToken).expect(200);
    await save(tenant.memberToken, 'user.invited/en', invitation).expect(403);
    await preview(tenant.memberToken, { event_key: 'user.invited', locale: 'en', ...invitation }).expect(403);
  });

  it('tenant B sees no override from tenant A', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    await save(a.ownerToken, 'user.invited/en', invitation).expect(200);

    const entries = (await list(b.ownerToken).expect(200)).body as { data: TemplateEntry[] };
    expect(entries.data.every((entry) => entry.overrides.length === 0)).toBe(true);
  });
});
