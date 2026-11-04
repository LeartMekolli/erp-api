import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { invitationPreviewResponseSchema } from '../src/modules/auth/invitation-preview.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'a-long-invitee-password';

/**
 * One link, three kinds of invitation: the preview tells the accept page which one a token is, who it
 * is for and what they join, and whether they need to set a password.
 */
describe('invitation preview', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const preview = (token: string) => http().get(`/auth/invitations/${encodeURIComponent(token)}`);
  const email = () => `invitee-${newId()}@example.test`;

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
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  /** A workspace with a customer site, its owner, the partner CastCo and the customer Luna Jewels. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await prisma.tenant.update({ where: { id: tenant.id }, data: { name: 'Acme Works', customerSiteOrigin: 'https://shop.example.test' } });
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const staff = {
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    };
    const castco = ((await staff.post('/partners', { name: 'CastCo', display_name: 'CastCo' }).expect(201)).body as { id: string }).id;
    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const memberRoleId = (await prisma.inTenant(tenant.id, (tx) => tx.role.findFirstOrThrow({ where: { name: 'member' } }))).id;
    return { ...tenant, staff, castco, luna, memberRoleId };
  }

  it('tells a staff, a partner and a customer invitation apart, with what each joins', async () => {
    const w = await workspace();
    const staffEmail = email();
    const partnerEmail = email();
    const customerEmail = email();
    await w.staff.post('/users/invitations', { email: staffEmail, role_id: w.memberRoleId }).expect(201);
    await w.staff.post(`/partners/${w.castco}/invitations`, { email: partnerEmail, role: 'admin' }).expect(201);
    await w.staff.post(`/customers/${w.luna}/invitations`, { email: customerEmail, role: 'buyer' }).expect(201);

    const cases = [
      { token: notifier.lastInvitationFor(staffEmail)!.token, kind: 'staff', email: staffEmail, role: 'member', organisation: null },
      { token: notifier.lastPartnerInvitationFor(partnerEmail)!.token, kind: 'partner', email: partnerEmail, role: 'admin', organisation: { name: 'CastCo' } },
      { token: notifier.lastCustomerInvitationFor(customerEmail)!.token, kind: 'customer', email: customerEmail, role: 'buyer', organisation: { name: 'Luna Jewels' } },
    ];
    for (const { token, ...expected } of cases) {
      const response = await preview(token).expect(200);
      expectDocumented(invitationPreviewResponseSchema, response.body);
      expect(response.body).toEqual({ ...expected, status: 'pending', workspace: { name: 'Acme Works' }, has_account: false });
    }
  });

  it('says when the invitee already has an account, so the page asks for no password', async () => {
    const w = await workspace();
    const person = email();
    const other = ((await w.staff.post('/partners', { name: 'MetalWorks', display_name: 'MetalWorks' }).expect(201)).body as { id: string }).id;
    await w.staff.post(`/partners/${other}/invitations`, { email: person, role: 'member' }).expect(201);
    await http()
      .post('/auth/partner-invitations/accept')
      .send({ token: notifier.lastPartnerInvitationFor(person)!.token, name: 'Pat', password: PASSWORD })
      .expect(204);

    await w.staff.post(`/partners/${w.castco}/invitations`, { email: person, role: 'member' }).expect(201);
    const response = await preview(notifier.lastPartnerInvitationFor(person)!.token).expect(200);
    expect(response.body).toMatchObject({ kind: 'partner', organisation: { name: 'CastCo' }, has_account: true, status: 'pending' });
  });

  it('says an invitation was accepted or has expired, so the page can say why it no longer works', async () => {
    const w = await workspace();
    const accepted = email();
    await w.staff.post(`/partners/${w.castco}/invitations`, { email: accepted, role: 'member' }).expect(201);
    const acceptedToken = notifier.lastPartnerInvitationFor(accepted)!.token;
    await http().post('/auth/partner-invitations/accept').send({ token: acceptedToken, name: 'Pat', password: PASSWORD }).expect(204);
    expect((await preview(acceptedToken).expect(200)).body).toMatchObject({ status: 'accepted', has_account: true });

    const expired = email();
    await w.staff.post('/users/invitations', { email: expired, role_id: w.memberRoleId }).expect(201);
    await prisma.inTenant(w.id, (tx) => tx.invitation.updateMany({ where: { email: expired }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    expect((await preview(notifier.lastInvitationFor(expired)!.token).expect(200)).body).toMatchObject({ kind: 'staff', status: 'expired' });
  });

  it("finds nothing for a token it never issued, another workspace's prefix, or a suspended workspace", async () => {
    const w = await workspace();
    const person = email();
    await w.staff.post('/users/invitations', { email: person, role_id: w.memberRoleId }).expect(201);
    const token = notifier.lastInvitationFor(person)!.token;

    const other = await createTestTenant(prisma);
    createdTenants.push(other.id);
    for (const unknown of ['not-a-token', `${w.id}.${'a'.repeat(43)}`, `${other.id}.${token.split('.')[1]}`]) {
      const response = await preview(unknown);
      expect({ unknown, status: response.status }).toEqual({ unknown, status: 404 });
    }

    await prisma.tenant.update({ where: { id: w.id }, data: { status: 'suspended' } });
    await preview(token).expect(404);
  });
});
