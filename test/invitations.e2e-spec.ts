import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const NEW_PASSWORD = 'a-brand-new-password';

describe('invitations', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const notifier = new CapturingIdentityNotifier();
  let tenant: { id: string; slug: string };
  let other: { id: string; slug: string };
  let ownerToken: string;
  let memberToken: string;
  let memberRoleId: string;

  const invite = (body: Record<string, string>, token = ownerToken) =>
    request(app.getHttpServer()).post('/users/invitations').set('Authorization', `Bearer ${token}`).send(body);

  const accept = (body: Record<string, string>) =>
    request(app.getHttpServer()).post('/auth/invitations/accept').send(body);

  const freshEmail = () => `invitee-${newId()}@example.test`;

  async function invitedToken(email: string, roleId = memberRoleId): Promise<string> {
    await invite({ email, role_id: roleId }).expect(201);
    const notice = notifier.lastInvitationFor(email);
    if (!notice) throw new Error(`no invitation captured for ${email}`);
    return notice.token;
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
    tokens = moduleRef.get(AccessTokenService);

    tenant = await createTestTenant(prisma);
    other = await createTestTenant(prisma);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    ownerToken = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    memberToken = (await tokens.issueForUser(tenant.id, member.id)).accessToken;
    memberRoleId = (
      await prisma.inTenant(tenant.id, (tx) => tx.role.findFirstOrThrow({ where: { name: 'member' } }))
    ).id;
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, [tenant.id, other.id]);
    await app.close();
  });

  it('lets an owner invite someone who then accepts and logs in with the role', async () => {
    const response = await invite({ email: '  New.Person@Example.TEST ', role_id: memberRoleId }).expect(201);
    const email = 'new.person@example.test';

    // The token goes to the notifier only, never into the response.
    expect(response.body).toEqual({ id: expect.any(String), email, expires_at: expect.any(String) });

    const token = notifier.lastInvitationFor(email)?.token ?? '';
    await accept({ token, name: 'New Person', password: NEW_PASSWORD }).expect(204);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: NEW_PASSWORD, workspace: tenant.slug })
      .expect(200);

    const user = await prisma.inTenant(tenant.id, (tx) =>
      tx.user.findFirstOrThrow({ where: { email }, include: { roles: true } }),
    );
    expect(user).toMatchObject({ name: 'New Person', status: 'active', locale: 'en' });
    expect(user.roles.map((role) => role.roleId)).toEqual([memberRoleId]);
  });

  it('accepts an invitation only once', async () => {
    const token = await invitedToken(freshEmail());

    await accept({ token, name: 'Once', password: NEW_PASSWORD }).expect(204);
    const again = await accept({ token, name: 'Twice', password: NEW_PASSWORD }).expect(400);

    expect((again.body as { detail: string }).detail).toBe('Invitation is invalid or expired');
  });

  it('refuses an expired invitation', async () => {
    const email = freshEmail();
    const token = await invitedToken(email);
    await prisma.inTenant(tenant.id, (tx) =>
      tx.invitation.updateMany({ where: { email }, data: { expiresAt: new Date(0) } }),
    );

    await accept({ token, name: 'Late', password: NEW_PASSWORD }).expect(400);
  });

  it('expires the earlier invitation when the same email is invited again', async () => {
    const email = freshEmail();
    const first = await invitedToken(email);
    const second = await invitedToken(email);

    await accept({ token: first, name: 'Old Link', password: NEW_PASSWORD }).expect(400);
    await accept({ token: second, name: 'New Link', password: NEW_PASSWORD }).expect(204);
  });

  it('refuses to invite an email that already belongs to an active user', async () => {
    const existing = await createTestUser(prisma, tenant.id);

    await invite({ email: existing.email, role_id: memberRoleId }).expect(409);
  });

  it('refuses to accept when the email was registered in the meantime', async () => {
    const email = freshEmail();
    const token = await invitedToken(email);
    await createTestUser(prisma, tenant.id, { email });

    await accept({ token, name: 'Too Late', password: NEW_PASSWORD }).expect(409);
  });

  it('does not let a member invite', async () => {
    await invite({ email: freshEmail(), role_id: memberRoleId }, memberToken).expect(403);
  });

  it("refuses another tenant's role id", async () => {
    const foreignRole = await prisma.inTenant(other.id, (tx) =>
      tx.role.findFirstOrThrow({ where: { name: 'owner' } }),
    );

    await invite({ email: freshEmail(), role_id: foreignRole.id }).expect(404);
  });

  it("finds nothing when the token's prefix is rewritten to another tenant", async () => {
    const token = await invitedToken(freshEmail());
    const secret = token.split('.')[1] ?? '';

    await accept({ token: `${other.id}.${secret}`, name: 'Moved', password: NEW_PASSWORD }).expect(400);
    await accept({ token: 'garbage', name: 'Garbage', password: NEW_PASSWORD }).expect(400);
  });

  it('validates the invitation and the acceptance bodies', async () => {
    const token = await invitedToken(freshEmail());

    const shortPassword = await accept({ token, name: 'Short', password: 'too-short' }).expect(400);
    expect((shortPassword.body as { errors: { path: string }[] }).errors.map((error) => error.path)).toContain(
      'password',
    );
    await invite({ email: 'not-an-email', role_id: memberRoleId }).expect(400);
    await invite({ email: freshEmail(), role_id: 'not-a-uuid' }).expect(400);
  });
});
