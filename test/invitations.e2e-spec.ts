import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { emailStatusOf, invitationResponseSchema } from '../src/modules/users/invitation-response';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const NEW_PASSWORD = 'a-brand-new-password';

describe('invitations', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const notifier = new CapturingIdentityNotifier();
  let tenant: { id: string; slug: string };
  let other: { id: string; slug: string };
  let ownerId: string;
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
    ownerId = owner.id;
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

    // The token goes to the notifier only, never into the response. The capturing notifier raises no
    // notification, so there is no email status to report.
    expectDocumented(invitationResponseSchema, response.body);
    expect(response.body).toEqual({
      id: expect.any(String),
      email,
      role: { id: memberRoleId, name: 'member' },
      invited_by: { id: ownerId, name: 'Test User' },
      status: 'waiting',
      created_at: expect.any(String),
      expires_at: expect.any(String),
      email_status: null,
    });

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

  describe('privilege rules and taken emails', () => {
    const createRole = async (name: string, permissions: string[]): Promise<string> =>
      (
        (
          await request(app.getHttpServer())
            .post('/roles')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ name, permissions })
            .expect(201)
        ).body as { id: string }
      ).id;

    /** A user holding only a new custom role with exactly these permissions. */
    async function leadWith(name: string, permissions: string[]) {
      const lead = await createTestUser(prisma, tenant.id, { roles: [] });
      const roleId = await createRole(name, permissions);
      await request(app.getHttpServer())
        .put(`/users/${lead.id}/roles`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role_ids: [roleId] })
        .expect(200);
      return { token: (await tokens.issueForUser(tenant.id, lead.id)).accessToken };
    }

    const codeOf = (body: unknown) => (body as { code: string }).code;

    it("refuses a role with permissions the caller lacks, and lets them hand out a role they can cover", async () => {
      const lead = await leadWith('Inviting lead', ['user.read', 'user.invite', 'role.read', 'order.read']);
      const packing = await createRole('Order readers', ['order.read']);
      const ownerRole = (
        await prisma.inTenant(tenant.id, (tx) => tx.role.findFirstOrThrow({ where: { name: 'owner', isSystem: true } }))
      ).id;

      const tooMuch = await invite({ email: freshEmail(), role_id: memberRoleId }, lead.token).expect(403);
      expect(codeOf(tooMuch.body)).toBe('exceeds_own_permissions');

      const ownerRefused = await invite({ email: freshEmail(), role_id: ownerRole }, lead.token).expect(403);
      expect(codeOf(ownerRefused.body)).toBe('owner_only');

      await invite({ email: freshEmail(), role_id: packing }, lead.token).expect(201);
    });

    it("refuses replacing an owner invitation, and leaves that invitation as it was", async () => {
      const lead = await leadWith('Replacing lead', ['user.read', 'user.invite', 'role.read', 'order.read']);
      const packing = await createRole('Packers', ['order.read']);
      const ownerRole = (
        await prisma.inTenant(tenant.id, (tx) => tx.role.findFirstOrThrow({ where: { name: 'owner', isSystem: true } }))
      ).id;
      const email = freshEmail();

      await invite({ email, role_id: ownerRole }).expect(201);
      const before = await prisma.inTenant(tenant.id, (tx) => tx.invitation.findFirstOrThrow({ where: { email } }));

      const refused = await invite({ email, role_id: packing }, lead.token).expect(403);

      expect(codeOf(refused.body)).toBe('owner_only');
      const after = await prisma.inTenant(tenant.id, (tx) => tx.invitation.findMany({ where: { email } }));
      expect(after).toHaveLength(1);
      expect(after[0]?.expiresAt).toEqual(before.expiresAt);
    });

    it("says a deactivated staff member's email is taken, and by whom", async () => {
      const gone = await createTestUser(prisma, tenant.id, { status: 'deactivated' });

      const response = await invite({ email: gone.email, role_id: memberRoleId }).expect(409);

      expect(response.body).toMatchObject({
        code: 'email_is_staff',
        user: { id: gone.id, name: 'Test User', status: 'deactivated' },
      });
    });

    it("says a customer person's email is taken, without naming them", async () => {
      const person = await createTestUser(prisma, tenant.id);
      await prisma.inTenant(tenant.id, (tx) =>
        tx.user.update({ where: { id: person.id }, data: { kind: 'customer' } }),
      );

      const response = await invite({ email: person.email, role_id: memberRoleId }).expect(409);

      expect(codeOf(response.body)).toBe('email_is_other_kind');
      expect(response.body).not.toHaveProperty('user');
    });

    it('answers 201 with a failed email status when raising the email throws, and keeps the invitation', async () => {
      const email = freshEmail();
      const spy = jest.spyOn(notifier, 'invitationCreated').mockRejectedValueOnce(new Error('queue down'));

      const response = await invite({ email, role_id: memberRoleId }).expect(201);
      spy.mockRestore();

      expect((response.body as { email_status: string }).email_status).toBe('failed');
      const stored = await prisma.inTenant(tenant.id, (tx) => tx.invitation.count({ where: { email } }));
      expect(stored).toBe(1);
    });
  });

  describe('email status', () => {
    async function raise(
      invitationId: string,
      status: string,
      deliveries: ('sent' | 'failed')[],
    ): Promise<void> {
      await prisma.inTenant(tenant.id, async (tx) => {
        const notification = await tx.notification.create({
          data: {
            eventKey: 'user.invited',
            audience: 'invitee',
            subjectType: 'invitation',
            subjectId: invitationId,
            payload: {},
            status,
          },
        });
        for (const [index, delivery] of deliveries.entries()) {
          await tx.notificationDelivery.create({
            data: {
              notificationId: notification.id,
              channel: 'email',
              target: 'x@example.test',
              status: delivery,
              attempt: index + 1,
              createdAt: new Date(Date.now() + index * 1000),
            },
          });
        }
      });
    }

    it('reads sent, failed and sending from the deliveries, and leaves out invitations without a notification', async () => {
      const [sent, retried, failedDelivery, failedNotification, pending, none] = [newId(), newId(), newId(), newId(), newId(), newId()];
      await raise(sent, 'done', ['sent']);
      await raise(retried, 'pending', ['failed', 'sent']);
      await raise(failedDelivery, 'pending', ['failed']);
      await raise(failedNotification, 'failed', []);
      await raise(pending, 'pending', []);

      const map = await prisma.inTenant(tenant.id, (tx) =>
        emailStatusOf(tx, [sent, retried, failedDelivery, failedNotification, pending, none]),
      );

      expect(Object.fromEntries(map)).toEqual({
        [sent]: 'sent',
        [retried]: 'sent',
        [failedDelivery]: 'failed',
        [failedNotification]: 'failed',
        [pending]: 'sending',
      });
    });
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
