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

  const listInvitations = (query = '', token = ownerToken) =>
    request(app.getHttpServer()).get(`/users/invitations${query}`).set('Authorization', `Bearer ${token}`);

  const cancel = (id: string, token = ownerToken) =>
    request(app.getHttpServer()).delete(`/users/invitations/${id}`).set('Authorization', `Bearer ${token}`);

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

    it('refuses a lead cancelling an owner invitation, and lets them cancel one for a role they can cover', async () => {
      const lead = await leadWith('Cancelling lead', ['user.read', 'user.invite', 'role.read', 'order.read']);
      const packing = await createRole('Cancel packers', ['order.read']);
      const ownerRole = (
        await prisma.inTenant(tenant.id, (tx) => tx.role.findFirstOrThrow({ where: { name: 'owner', isSystem: true } }))
      ).id;
      const ownerEmail = freshEmail();
      const packingEmail = freshEmail();
      const ownerInvitation = ((await invite({ email: ownerEmail, role_id: ownerRole }).expect(201)).body as { id: string }).id;
      const packingInvitation = ((await invite({ email: packingEmail, role_id: packing }).expect(201)).body as { id: string }).id;

      const refused = await cancel(ownerInvitation, lead.token).expect(403);
      await cancel(packingInvitation, lead.token).expect(204);

      expect(codeOf(refused.body)).toBe('owner_only');
      const stored = await prisma.inTenant(tenant.id, (tx) =>
        tx.invitation.findMany({ where: { id: { in: [ownerInvitation, packingInvitation] } } }),
      );
      expect(stored.find((row) => row.id === ownerInvitation)?.cancelledAt).toBeNull();
      expect(stored.find((row) => row.id === packingInvitation)?.cancelledAt).not.toBeNull();
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

  describe('listing and cancelling', () => {
    type Listed = { id: string; email: string; status: string; invited_by: unknown; email_status: string | null };

    /** Every invitation this spec's tenant lists, whichever test made it; tests pick theirs by email. */
    async function listed(query = '', token = ownerToken): Promise<Listed[]> {
      const response = await listInvitations(`?limit=200${query}`, token).expect(200);
      return (response.body as { data: Listed[] }).data;
    }

    const idOf = async (email: string): Promise<string> =>
      (await prisma.inTenant(tenant.id, (tx) => tx.invitation.findFirstOrThrow({ where: { email }, orderBy: { id: 'desc' } })))
        .id;

    const insertInvitation = (email: string, data: Record<string, unknown> = {}) =>
      prisma.inTenant(tenant.id, (tx) =>
        tx.invitation.create({
          data: {
            email,
            roleId: memberRoleId,
            tokenHash: newId(),
            expiresAt: new Date(Date.now() + 86_400_000),
            invitedByUserId: ownerId,
            ...data,
          },
        }),
      );

    it('lists the newest invitation of each email, newest first, in the documented shape', async () => {
      const a = freshEmail();
      const b = freshEmail();
      await invite({ email: a, role_id: memberRoleId }).expect(201);
      await invite({ email: a, role_id: memberRoleId }).expect(201);
      await invite({ email: b, role_id: memberRoleId }).expect(201);
      const secondOfA = (await listed()).find((row) => row.email === a)?.id;

      const rows = (await listed()).filter((row) => [a, b].includes(row.email));

      expect(rows.map((row) => row.email)).toEqual([b, a]);
      expect(rows[1]?.id).toBe(secondOfA);
      expect(secondOfA).toBe(await idOf(a));
      const page = (await listInvitations('?limit=200').expect(200)).body as { data: unknown[] };
      for (const row of page.data) expectDocumented(invitationResponseSchema, row);
    });

    it('lists only the newer of two waiting invitations for one email', async () => {
      const email = freshEmail();
      const older = await insertInvitation(email, { createdAt: new Date(Date.now() - 60_000) });
      const newer = await insertInvitation(email, { createdAt: new Date() });

      const ids = (await listed()).filter((row) => row.email === email).map((row) => row.id);

      expect(ids).toEqual([newer.id]);
      expect(ids).not.toContain(older.id);
    });

    it('pages by id, newest first', async () => {
      const emails = [freshEmail(), freshEmail(), freshEmail()];
      for (const email of emails) await invite({ email, role_id: memberRoleId }).expect(201);

      const first = (await listInvitations('?limit=2').expect(200)).body as { data: Listed[]; next_cursor: string };
      const second = (await listInvitations(`?limit=2&cursor=${first.next_cursor}`).expect(200)).body as {
        data: Listed[];
      };

      expect(first.data).toHaveLength(2);
      expect(first.data[0]?.email).toBe(emails[2]);
      expect(first.data[1]?.email).toBe(emails[1]);
      expect(second.data[0]?.email).toBe(emails[0]);
    });

    it('lists an expired invitation as expired, and ?status filters', async () => {
      const email = freshEmail();
      await invite({ email, role_id: memberRoleId }).expect(201);
      await prisma.inTenant(tenant.id, (tx) =>
        tx.invitation.updateMany({ where: { email }, data: { expiresAt: new Date(0) } }),
      );

      expect((await listed()).find((row) => row.email === email)?.status).toBe('expired');
      expect((await listed('&status=waiting')).some((row) => row.email === email)).toBe(false);
      expect((await listed('&status=expired')).some((row) => row.email === email)).toBe(true);
      await listInvitations('?status=nonsense').expect(400);
    });

    it('leaves out accepted, cancelled and now-staff invitations', async () => {
      const accepted = freshEmail();
      const cancelled = freshEmail();
      const registered = freshEmail();
      const waiting = freshEmail();
      await accept({ token: await invitedToken(accepted), name: 'Accepted', password: NEW_PASSWORD }).expect(204);
      await invite({ email: cancelled, role_id: memberRoleId }).expect(201);
      await cancel(await idOf(cancelled)).expect(204);
      await invite({ email: registered, role_id: memberRoleId }).expect(201);
      await createTestUser(prisma, tenant.id, { email: registered });
      await invite({ email: waiting, role_id: memberRoleId }).expect(201);

      const emails = (await listed()).map((row) => row.email);

      expect(emails).toContain(waiting);
      expect(emails).not.toContain(accepted);
      expect(emails).not.toContain(cancelled);
      expect(emails).not.toContain(registered);
    });

    it('answers invited_by null for an invitation without an inviter', async () => {
      const email = freshEmail();
      await insertInvitation(email, { invitedByUserId: null });

      expect((await listed()).find((row) => row.email === email)?.invited_by).toBeNull();
    });

    it("reports the email status from the invitation's deliveries", async () => {
      const sentEmail = freshEmail();
      const failedEmail = freshEmail();
      const sent = (await insertInvitation(sentEmail)).id;
      const failed = (await insertInvitation(failedEmail)).id;
      for (const [invitationId, status] of [
        [sent, 'sent'],
        [failed, 'failed'],
      ] as const) {
        await prisma.inTenant(tenant.id, async (tx) => {
          const notification = await tx.notification.create({
            data: {
              eventKey: 'user.invited',
              audience: 'invitee',
              subjectType: 'invitation',
              subjectId: invitationId,
              payload: {},
              status: 'pending',
            },
          });
          await tx.notificationDelivery.create({
            data: { notificationId: notification.id, channel: 'email', target: 'x@example.test', status, attempt: 1 },
          });
        });
      }

      const rows = await listed();

      expect(rows.find((row) => row.email === sentEmail)?.email_status).toBe('sent');
      expect(rows.find((row) => row.email === failedEmail)?.email_status).toBe('failed');
    });

    it('cancels a waiting invitation: its token fails like an expired one, it leaves the list, one audit entry', async () => {
      const email = freshEmail();
      const token = await invitedToken(email);
      const id = await idOf(email);

      await cancel(id).expect(204);
      await cancel(id).expect(204);

      const attempt = await accept({ token, name: 'Cancelled', password: NEW_PASSWORD }).expect(400);
      expect((attempt.body as { detail: string }).detail).toBe('Invitation is invalid or expired');
      expect((await listed()).some((row) => row.email === email)).toBe(false);
      const entries = await prisma.inTenant(tenant.id, (tx) =>
        tx.auditEntry.findMany({ where: { action: 'invitation.cancelled', subjectId: id } }),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actorId).toBe(ownerId);
    });

    it('cancels an expired invitation, which then leaves the list', async () => {
      const email = freshEmail();
      const expired = await insertInvitation(email, { expiresAt: new Date(0) });

      await cancel(expired.id).expect(204);

      expect((await listed()).some((row) => row.email === email)).toBe(false);
    });

    it('refuses to cancel an accepted invitation', async () => {
      const email = freshEmail();
      const accepted = await insertInvitation(email, { acceptedAt: new Date() });

      const response = await cancel(accepted.id).expect(409);

      expect((response.body as { code: string }).code).toBe('already_accepted');
    });

    it('answers 404 for an unknown invitation and for another workspace', async () => {
      const foreign = await prisma.inTenant(other.id, async (tx) => {
        const role = await tx.role.findFirstOrThrow({ where: { name: 'member' } });
        return tx.invitation.create({
          data: { email: freshEmail(), roleId: role.id, tokenHash: newId(), expiresAt: new Date(Date.now() + 86_400_000) },
        });
      });

      await cancel(newId()).expect(404);
      await cancel(foreign.id).expect(404);
      await cancel('not-a-uuid').expect(400);
      const untouched = await prisma.inTenant(other.id, (tx) => tx.invitation.findUniqueOrThrow({ where: { id: foreign.id } }));
      expect(untouched.cancelledAt).toBeNull();
      expect((await listed()).some((row) => row.id === foreign.id)).toBe(false);
    });

    it('lets a member read the list but not cancel', async () => {
      const email = freshEmail();
      await invite({ email, role_id: memberRoleId }).expect(201);

      await listInvitations('', memberToken).expect(200);
      await cancel(await idOf(email), memberToken).expect(403);
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
