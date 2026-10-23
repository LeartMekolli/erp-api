import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { GOOGLE_TOKEN_VERIFIER, GoogleTokenVerifier } from '../src/modules/auth/google-token-verifier';
import { sessionTokensSchema } from '../src/modules/auth/session.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { testGoogleKeys } from './google';
import type { TestGoogleKeys } from './google';

describe('sign in with Google', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let keys: TestGoogleKeys;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const signIn = (body: object) => http().post('/auth/google').send(body);
  const meOf = async (accessToken: string) =>
    (await http().get('/me').set('Authorization', `Bearer ${accessToken}`).expect(200)).body as { user: { id: string } };

  beforeAll(async () => {
    keys = await testGoogleKeys();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GOOGLE_TOKEN_VERIFIER)
      .useValue(new GoogleTokenVerifier(keys.keySet))
      .overrideProvider(IDENTITY_NOTIFIER)
      .useValue(notifier)
      .compile();
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

  /** A workspace whose site signs in with its own Google client id, unless `google` is false. */
  async function freshTenant(google = true) {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const ownerToken = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const clientId = `client-${newId()}.apps.example.test`;
    if (google) {
      await http()
        .put('/settings/auth.google')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ clientIds: [clientId] })
        .expect(200);
    }
    const links = () => prisma.inTenant(tenant.id, (tx) => tx.externalIdentity.findMany({ where: { provider: 'google' } }));
    return { ...tenant, owner, ownerToken, clientId, links };
  }

  it('signs a staff user in by verified email the first time, then by the linked Google account', async () => {
    const tenant = await freshTenant();
    const idToken = await keys.mint({ aud: tenant.clientId, sub: 'g-owner', email: tenant.owner.email });

    const first = await signIn({ workspace: tenant.slug, id_token: idToken }).expect(200);
    expectDocumented(sessionTokensSchema, first.body);
    expect((await meOf((first.body as { access_token: string }).access_token)).user.id).toBe(tenant.owner.id);
    expect((await tenant.links()).map((link) => [link.subject, link.userId])).toEqual([['g-owner', tenant.owner.id]]);

    // The Google account keeps working after the user's email changes.
    await prisma.inTenant(tenant.id, (tx) =>
      tx.user.update({ where: { id: tenant.owner.id }, data: { email: `renamed-${newId()}@example.test` } }),
    );
    const again = await signIn({
      workspace: tenant.slug,
      id_token: await keys.mint({ aud: tenant.clientId, sub: 'g-owner', email: 'someone-else@example.test' }),
    }).expect(200);
    expect((await meOf((again.body as { access_token: string }).access_token)).user.id).toBe(tenant.owner.id);
  });

  it("refuses an unverified email, another workspace's client id, an expired token, an unknown email, and a disabled user", async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();

    // Review focus 5.
    const unverified = await keys.mint({ aud: tenant.clientId, sub: 'g-1', email: tenant.owner.email, email_verified: false });
    await signIn({ workspace: tenant.slug, id_token: unverified }).expect(401);
    const foreign = await keys.mint({ aud: other.clientId, sub: 'g-2', email: tenant.owner.email });
    await signIn({ workspace: tenant.slug, id_token: foreign }).expect(401);
    const expired = await keys.mint({
      aud: tenant.clientId,
      sub: 'g-3',
      email: tenant.owner.email,
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });
    await signIn({ workspace: tenant.slug, id_token: expired }).expect(401);
    const stranger = await keys.mint({ aud: tenant.clientId, sub: 'g-4', email: `stranger-${newId()}@example.test` });
    await signIn({ workspace: tenant.slug, id_token: stranger }).expect(401);
    expect(await tenant.links()).toEqual([]);

    const disabled = await createTestUser(prisma, tenant.id, { status: 'disabled' });
    const disabledToken = await keys.mint({ aud: tenant.clientId, sub: 'g-5', email: disabled.email });
    await signIn({ workspace: tenant.slug, id_token: disabledToken }).expect(401);

    const anyToken = await keys.mint({ aud: tenant.clientId, sub: 'g-6', email: tenant.owner.email });
    await signIn({ workspace: 'no-such-workspace', id_token: anyToken }).expect(401);
    await signIn({ workspace: tenant.slug }).expect(400);
  });

  it('is not offered by a workspace that has not set up Google', async () => {
    const tenant = await freshTenant(false);
    const idToken = await keys.mint({ aud: tenant.clientId, sub: 'g-owner', email: tenant.owner.email });

    await signIn({ workspace: tenant.slug, id_token: idToken }).expect(404);
  });

  it('accepts a customer invitation with Google instead of a password, then signs in with Google', async () => {
    const tenant = await freshTenant();
    const customer = (
      (await http().post('/customers').set('Authorization', `Bearer ${tenant.ownerToken}`).send({ name: 'Luna Jewels' }).expect(201))
        .body as { id: string }
    ).id;
    const invite = async (email: string) => {
      await http()
        .post(`/customers/${customer}/invitations`)
        .set('Authorization', `Bearer ${tenant.ownerToken}`)
        .send({ email, role: 'buyer' })
        .expect(201);
      return notifier.lastCustomerInvitationFor(email)!.token;
    };
    const accept = (body: object) => http().post('/auth/customer-invitations/accept').send(body);

    // A Google account with a different email cannot take the invitation.
    const anna = `anna-${newId()}@luna.example.test`;
    const annaInvitation = await invite(anna);
    const wrongAccount = await keys.mint({ aud: tenant.clientId, sub: 'g-x', email: `x-${newId()}@example.test` });
    await accept({ token: annaInvitation, google_id_token: wrongAccount }).expect(400);
    // Neither a password and Google together, nor an unverified Google email.
    const annaGoogle = await keys.mint({ aud: tenant.clientId, sub: 'g-anna', email: anna, name: 'Anna' });
    await accept({ token: annaInvitation, google_id_token: annaGoogle, password: 'a-long-customer-password' }).expect(400);
    const unverified = await keys.mint({ aud: tenant.clientId, sub: 'g-anna', email: anna, email_verified: false });
    await accept({ token: annaInvitation, google_id_token: unverified }).expect(400);

    await accept({ token: annaInvitation, google_id_token: annaGoogle }).expect(204);

    const members = (
      await http().get(`/customers/${customer}/members`).set('Authorization', `Bearer ${tenant.ownerToken}`).expect(200)
    ).body as { data: { email: string; name: string }[] };
    expect(members.data).toEqual([expect.objectContaining({ email: anna, name: 'Anna' })]);

    const session = await signIn({ workspace: tenant.slug, id_token: annaGoogle }).expect(200);
    const portal = await http()
      .get('/portal/me')
      .set('Authorization', `Bearer ${(session.body as { access_token: string }).access_token}`)
      .expect(200);
    expect((portal.body as { customers: { id: string }[] }).customers.map((entry) => entry.id)).toEqual([customer]);
  });
});
