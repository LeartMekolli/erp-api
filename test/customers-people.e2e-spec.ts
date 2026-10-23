import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import {
  customerInvitationResponseSchema,
  customerMemberResponseSchema,
  customerSiteResponseSchema,
} from '../src/modules/customers/customer-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'a-long-customer-password';

interface Member {
  user_id: string;
  name: string;
  email: string;
  role: string;
  status: string;
}

describe('customers: people and invitations', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const freshEmail = (name: string) => `${name}-${newId()}@luna.example.test`;

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const as = (token: string) => ({
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    });
    return {
      id: tenant.id,
      slug: tenant.slug,
      ownerEmail: owner.email,
      owner: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken),
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      as,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const customer = async (tenant: Tenant, name: string) =>
    ((await tenant.owner.post('/customers', { name }).expect(201)).body as { id: string }).id;

  async function invite(tenant: Tenant, customerId: string, email: string, role: string): Promise<string> {
    const response = await tenant.owner.post(`/customers/${customerId}/invitations`, { email, role }).expect(201);
    expectDocumented(customerInvitationResponseSchema, response.body);
    const notice = notifier.lastCustomerInvitationFor(email);
    if (!notice) throw new Error(`no customer invitation captured for ${email}`);
    return notice.token;
  }

  const accept = (body: object) => http().post('/auth/customer-invitations/accept').send(body);

  async function login(tenant: Tenant, email: string): Promise<string> {
    const response = await http().post('/auth/login').send({ email, password: PASSWORD, workspace: tenant.slug }).expect(200);
    return (response.body as { access_token: string }).access_token;
  }

  const members = async (tenant: Tenant, customerId: string): Promise<Member[]> => {
    const response = await tenant.owner.get(`/customers/${customerId}/members`).expect(200);
    const data = (response.body as { data: Member[] }).data;
    data.forEach((member) => expectDocumented(customerMemberResponseSchema, member));
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

  it("records the workspace's customer site, which may then call the API", async () => {
    const tenant = await freshTenant();
    const origin = `https://shop-${newId().slice(-8)}.example.test`;

    const set = await tenant.owner.put('/workspace/customer-site', { origin }).expect(200);
    expectDocumented(customerSiteResponseSchema, set.body);
    expect(set.body).toEqual({ origin });

    const allowed = await http().get('/health/live').set('Origin', origin);
    expect(allowed.headers['access-control-allow-origin']).toBe(origin);
    const unknown = await http().get('/health/live').set('Origin', 'https://unknown.example.test');
    expect(unknown.headers['access-control-allow-origin']).toBeUndefined();

    for (const body of [{ origin: 'http://shop.example.test' }, { origin: 'https://shop.example.test/path' }, { origin: 'shop' }, {}]) {
      const response = await tenant.owner.put('/workspace/customer-site', body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    await tenant.member.put('/workspace/customer-site', { origin }).expect(403);

    expect((await tenant.owner.put('/workspace/customer-site', { origin: null }).expect(200)).body).toEqual({ origin: null });
    const cleared = await http().get('/health/live').set('Origin', origin);
    expect(cleared.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('invites the first person as owner, who accepts, logs in, and has no staff access', async () => {
    const tenant = await freshTenant();
    const luna = await customer(tenant, 'Luna Jewels');
    const anna = freshEmail('anna');

    const token = await invite(tenant, luna, anna, 'owner');
    expect(notifier.lastCustomerInvitationFor(anna)).toMatchObject({ tenantId: tenant.id, customerName: 'Luna Jewels' });
    await accept({ token, name: 'Anna', password: PASSWORD }).expect(204);

    expect(await members(tenant, luna)).toEqual([{ user_id: expect.any(String), name: 'Anna', email: anna, role: 'owner', status: 'active' }]);
    expect(((await tenant.owner.get(`/customers/${luna}`).expect(200)).body as { member_count: number }).member_count).toBe(1);

    const annaToken = await login(tenant, anna);
    const asAnna = tenant.as(annaToken);
    await asAnna.get('/customers').expect(403);
    await asAnna.get('/users').expect(403);
    await asAnna.get('/catalog/products').expect(403);

    // The same token twice, and a token that is not one.
    await accept({ token, name: 'Anna', password: PASSWORD }).expect(400);
    await accept({ token: 'not-a-token', name: 'Anna', password: PASSWORD }).expect(400);
  });

  it('refuses a second owner, a staff email, a bad role, and a new person without a password', async () => {
    const tenant = await freshTenant();
    const luna = await customer(tenant, 'Luna Jewels');
    await accept({ token: await invite(tenant, luna, freshEmail('anna'), 'owner'), name: 'Anna', password: PASSWORD }).expect(204);

    await tenant.owner.post(`/customers/${luna}/invitations`, { email: freshEmail('ben'), role: 'owner' }).expect(409);
    await tenant.owner.post(`/customers/${luna}/invitations`, { email: tenant.ownerEmail, role: 'buyer' }).expect(409);
    for (const body of [{ email: freshEmail('ben'), role: 'boss' }, { email: 'not-an-email', role: 'buyer' }, { role: 'buyer' }]) {
      const response = await tenant.owner.post(`/customers/${luna}/invitations`, body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }

    const benToken = await invite(tenant, luna, freshEmail('ben'), 'buyer');
    await accept({ token: benToken }).expect(400);
    await accept({ token: benToken, name: 'Ben', password: 'short' }).expect(400);
    await accept({ token: benToken, name: 'Ben', password: PASSWORD }).expect(204);
  });

  it('adds a membership when an existing customer person is invited to another customer', async () => {
    const tenant = await freshTenant();
    const luna = await customer(tenant, 'Luna Jewels');
    const sol = await customer(tenant, 'Sol Rings');
    const ben = freshEmail('ben');
    await accept({ token: await invite(tenant, luna, ben, 'buyer'), name: 'Ben', password: PASSWORD }).expect(204);

    await accept({ token: await invite(tenant, sol, ben, 'viewer') }).expect(204);

    expect((await members(tenant, sol)).map((member) => [member.email, member.role])).toEqual([[ben, 'viewer']]);
    expect((await members(tenant, luna)).map((member) => [member.email, member.role])).toEqual([[ben, 'buyer']]);
    const people = await prisma.inTenant(tenant.id, (tx) => tx.user.count({ where: { email: ben } }));
    expect(people).toBe(1);
  });

  it('lets staff change roles, hand over ownership, and disable a person', async () => {
    const tenant = await freshTenant();
    const luna = await customer(tenant, 'Luna Jewels');
    const anna = freshEmail('anna');
    const ben = freshEmail('ben');
    await accept({ token: await invite(tenant, luna, anna, 'owner'), name: 'Anna', password: PASSWORD }).expect(204);
    await accept({ token: await invite(tenant, luna, ben, 'buyer'), name: 'Ben', password: PASSWORD }).expect(204);
    const id = async (email: string) => (await members(tenant, luna)).find((member) => member.email === email)!.user_id;

    const promoted = await tenant.owner.patch(`/customers/${luna}/members/${await id(ben)}`, { role: 'owner' }).expect(200);
    expectDocumented(customerMemberResponseSchema, promoted.body);
    expect((await members(tenant, luna)).map((member) => [member.email, member.role]).sort()).toEqual(
      [
        [anna, 'admin'],
        [ben, 'owner'],
      ].sort(),
    );

    const session = (await http().post('/auth/login').send({ email: anna, password: PASSWORD, workspace: tenant.slug }).expect(200))
      .body as { access_token: string; refresh_token: string };
    await tenant.as(session.access_token).get('/me').expect(200);
    // The same word as staff deactivation, and her sessions end with it.
    const deactivated = await tenant.owner.patch(`/customers/${luna}/members/${await id(anna)}`, { status: 'deactivated' }).expect(200);
    expect(deactivated.body).toMatchObject({ status: 'deactivated' });
    await tenant.as(session.access_token).get('/me').expect(401);
    await http().post('/auth/login').send({ email: anna, password: PASSWORD, workspace: tenant.slug }).expect(401);
    await tenant.owner.patch(`/customers/${luna}/members/${await id(anna)}`, { status: 'active' }).expect(200);
    await http().post('/auth/refresh').send({ refresh_token: session.refresh_token }).expect(401);
    await tenant.owner.patch(`/customers/${luna}/members/${await id(anna)}`, { status: 'disabled' }).expect(400);

    await tenant.owner.patch(`/customers/${luna}/members/${await id(anna)}`, { role: 'boss' }).expect(400);
    await tenant.owner.patch(`/customers/${luna}/members/${newId()}`, { role: 'buyer' }).expect(404);
  });

  it('never lets a customer person hold staff permissions', async () => {
    const tenant = await freshTenant();
    const luna = await customer(tenant, 'Luna Jewels');
    const anna = freshEmail('anna');
    await accept({ token: await invite(tenant, luna, anna, 'owner'), name: 'Anna', password: PASSWORD }).expect(204);
    const annaId = (await members(tenant, luna))[0].user_id;
    const ownerRole = await prisma.inTenant(tenant.id, (tx) => tx.role.findFirstOrThrow({ where: { name: 'owner' } }));

    // The staff user routes do not know customer people.
    await tenant.owner.put(`/users/${annaId}/roles`, { role_ids: [ownerRole.id] }).expect(404);
    await tenant.owner.post(`/users/${annaId}/deactivate`, {}).expect(404);

    // A workspace role written past the API still grants a customer person nothing.
    await prisma.inTenant(tenant.id, (tx) => tx.userRole.create({ data: { userId: annaId, roleId: ownerRole.id } }));
    const asAnna = tenant.as(await login(tenant, anna));
    await asAnna.get('/customers').expect(403);
    await asAnna.get('/users').expect(403);
  });

  it('keeps invitations and members to staff who may manage customers, and to the workspace', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const luna = await customer(a, 'Luna Jewels');

    await a.member.get(`/customers/${luna}/members`).expect(200);
    await a.member.post(`/customers/${luna}/invitations`, { email: freshEmail('ben'), role: 'buyer' }).expect(403);
    await b.owner.post(`/customers/${luna}/invitations`, { email: freshEmail('ben'), role: 'buyer' }).expect(404);
    await b.owner.get(`/customers/${luna}/members`).expect(404);
  });
});
