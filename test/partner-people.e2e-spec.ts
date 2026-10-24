import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import {
  partnerInvitationResponseSchema,
  partnerMeResponseSchema,
  partnerMemberResponseSchema,
} from '../src/modules/partners/partner-response';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'a-long-partner-password';

interface Member {
  user_id: string;
  name: string;
  email: string;
  role: string;
  status: string;
}

describe('partners: people, invitations and the partner portal', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const freshEmail = (name: string) => `${name}-${newId()}@castco.example.test`;
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const castco = ((await staff.post('/partners', { name: 'CastCo Ltd', display_name: 'CastCo' }).expect(201)).body as { id: string }).id;
    return { id: tenant.id, slug: tenant.slug, staffEmail: owner.email, staff, castco };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const accept = (body: object) => http().post('/auth/partner-invitations/accept').send(body);

  /** Invites through `path` as `by`, accepts as a new person, and returns their user id and a client. */
  async function join(tenant: Tenant, by: ReturnType<typeof as>, path: string, email: string, role: string) {
    const invited = await by.post(path, { email, role }).expect(201);
    expectDocumented(partnerInvitationResponseSchema, invited.body);
    const notice = notifier.lastPartnerInvitationFor(email);
    if (!notice) throw new Error(`no partner invitation captured for ${email}`);
    await accept({ token: notice.token, name: email.split('-')[0], password: PASSWORD }).expect(204);
    const login = await http().post('/auth/login').send({ email, password: PASSWORD, workspace: tenant.slug }).expect(200);
    const token = (login.body as { access_token: string }).access_token;
    return { token, notice, client: as(token) };
  }

  const members = async (tenant: Tenant): Promise<Member[]> => {
    const response = await tenant.staff.get(`/partners/${tenant.castco}/members`).expect(200);
    const data = (response.body as { data: Member[] }).data;
    data.forEach((member) => expectDocumented(partnerMemberResponseSchema, member));
    return data;
  };

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

  it('invites the first person as owner, who logs in to the partner portal and has no staff access', async () => {
    const tenant = await freshTenant();
    const ana = freshEmail('ana');

    const { notice, client } = await join(tenant, tenant.staff, `/partners/${tenant.castco}/invitations`, ana, 'owner');
    expect(notice).toMatchObject({ tenantId: tenant.id, partnerName: 'CastCo' });
    expect(await members(tenant)).toEqual([{ user_id: expect.any(String), name: 'ana', email: ana, role: 'owner', status: 'active' }]);
    expect(((await tenant.staff.get(`/partners/${tenant.castco}`).expect(200)).body as { member_count: number }).member_count).toBe(1);

    const me = await client.get('/partner-portal/me').expect(200);
    expectDocumented(partnerMeResponseSchema, me.body);
    expect(me.body).toMatchObject({
      user: { name: 'ana', email: ana },
      partners: [{ id: tenant.castco, display_name: 'CastCo', role: 'owner', status: 'setting_up' }],
    });

    for (const path of ['/partners', '/customers', '/users', '/workflow/work-orders']) {
      await client.get(path).expect(403);
    }

    await accept({ token: notice.token, name: 'ana', password: PASSWORD }).expect(400);
    await accept({ token: 'not-a-token', name: 'ana', password: PASSWORD }).expect(400);
  });

  it("lets the owner and admins invite and remove people, never the owner, and keeps members to working", async () => {
    const tenant = await freshTenant();
    const portal = `/partner-portal/partners/${tenant.castco}`;
    const owner = await join(tenant, tenant.staff, `/partners/${tenant.castco}/invitations`, freshEmail('ana'), 'owner');
    const admin = await join(tenant, owner.client, `${portal}/invitations`, freshEmail('bo'), 'admin');
    const member = await join(tenant, admin.client, `${portal}/invitations`, freshEmail('cy'), 'member');

    expect((await members(tenant)).map((one) => one.role)).toEqual(['owner', 'admin', 'member']);
    const listed = await member.client.get(`${portal}/members`).expect(200);
    expect((listed.body as { data: Member[] }).data).toHaveLength(3);

    await member.client.post(`${portal}/invitations`, { email: freshEmail('dee'), role: 'member' }).expect(403);
    await owner.client.post(`${portal}/invitations`, { email: freshEmail('eve'), role: 'owner' }).expect(409);
    await tenant.staff.post(`/partners/${tenant.castco}/invitations`, { email: freshEmail('eve'), role: 'owner' }).expect(409);
    await owner.client.post(`${portal}/invitations`, { email: 'not-an-email', role: 'member' }).expect(400);
    await owner.client.post(`${portal}/invitations`, { email: freshEmail('fay'), role: 'boss' }).expect(400);

    const ownerId = (await members(tenant)).find((one) => one.role === 'owner')!.user_id;
    const memberId = (await members(tenant)).find((one) => one.role === 'member')!.user_id;
    await admin.client.delete(`${portal}/members/${ownerId}`).expect(409);
    await member.client.delete(`${portal}/members/${ownerId}`).expect(403);
    await admin.client.delete(`${portal}/members/${memberId}`).expect(204);
    expect((await member.client.get('/partner-portal/me').expect(200)).body).toMatchObject({ partners: [] });
    await member.client.get(`${portal}/members`).expect(404);
  });

  it('keeps staff, customer people and partner people apart', async () => {
    const tenant = await freshTenant();

    // A staff email can't become a partner person.
    await tenant.staff.post(`/partners/${tenant.castco}/invitations`, { email: tenant.staffEmail, role: 'owner' }).expect(409);

    // Nor can a customer person's.
    const customerPerson = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, (tx) => tx.user.update({ where: { id: customerPerson.id }, data: { kind: 'customer' } }));
    await tenant.staff.post(`/partners/${tenant.castco}/invitations`, { email: customerPerson.email, role: 'owner' }).expect(409);

    // And a partner person can't be invited to act for a customer.
    const ana = freshEmail('ana');
    await join(tenant, tenant.staff, `/partners/${tenant.castco}/invitations`, ana, 'owner');
    const luna = ((await tenant.staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    await tenant.staff.post(`/customers/${luna}/invitations`, { email: ana, role: 'owner' }).expect(409);
  });
});
