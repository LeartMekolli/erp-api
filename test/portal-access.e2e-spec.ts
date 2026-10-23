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
  portalMeResponseSchema,
} from '../src/modules/customers/customer-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'a-long-customer-password';

interface Member {
  user_id: string;
  email: string;
  role: string;
}

type Client = ReturnType<typeof clientFor>;

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return {
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`),
  };
}

describe('portal: acting for a customer, and managing its people', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];

  const freshEmail = (name: string) => `${name}-${newId()}@portal.example.test`;
  const portal = (customerId: string, rest = '') => `/portal/customers/${customerId}${rest}`;

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

  /**
   * A workspace with three customers: Anna owns Luna; Ben is a buyer at Luna
   * and a viewer at Sol; Mira Studio belongs to Mo alone.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const staffOwner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, staffOwner.id)).accessToken);

    const customer = async (name: string) => ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
    const luna = await customer('Luna Jewels');
    const sol = await customer('Sol Rings');
    const mira = await customer('Mira Studio');

    /** Invited by staff; a new email sets a name and password, an existing customer person only the token. */
    async function join(customerId: string, email: string, role: string, name?: string) {
      await staff.post(`/customers/${customerId}/invitations`, { email, role }).expect(201);
      const token = notifier.lastCustomerInvitationFor(email)!.token;
      await request(app.getHttpServer())
        .post('/auth/customer-invitations/accept')
        .send(name ? { token, name, password: PASSWORD } : { token })
        .expect(204);
    }

    async function personClient(email: string): Promise<{ id: string; client: Client }> {
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      return { id: user.id, client: clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken) };
    }

    const annaEmail = freshEmail('anna');
    const benEmail = freshEmail('ben');
    await join(luna, annaEmail, 'owner', 'Anna');
    await join(luna, benEmail, 'buyer', 'Ben');
    await join(sol, benEmail, 'viewer');
    await join(mira, freshEmail('mo'), 'owner', 'Mo');

    return {
      tenantId: tenant.id,
      staff,
      luna,
      sol,
      mira,
      anna: { email: annaEmail, ...(await personClient(annaEmail)) },
      ben: { email: benEmail, ...(await personClient(benEmail)) },
      join,
      personClient,
    };
  }

  const roles = async (client: Client, customerId: string): Promise<Record<string, string>> => {
    const response = await client.get(portal(customerId, '/members')).expect(200);
    const data = (response.body as { data: Member[] }).data;
    data.forEach((member) => expectDocumented(customerMemberResponseSchema, member));
    return Object.fromEntries(data.map((member) => [member.email, member.role]));
  };

  it('lists the customers a person acts for, with their role in each', async () => {
    const w = await workspace();

    const response = await w.ben.client.get('/portal/me').expect(200);

    expectDocumented(portalMeResponseSchema, response.body);
    expect(response.body).toEqual({
      user: { id: w.ben.id, name: 'Ben', email: w.ben.email },
      customers: [
        { id: w.luna, name: 'Luna Jewels', role: 'buyer' },
        { id: w.sol, name: 'Sol Rings', role: 'viewer' },
      ],
    });
  });

  it("shows a customer's people to its members, and nobody else's", async () => {
    const w = await workspace();
    const other = await workspace();

    expect(await roles(w.ben.client, w.luna)).toEqual({ [w.anna.email]: 'owner', [w.ben.email]: 'buyer' });

    // Review focus 1: swapping the customer id in the path never reaches another organisation.
    await w.ben.client.get(portal(w.mira, '/members')).expect(404);
    await w.ben.client.get(portal(newId(), '/members')).expect(404);
    await w.ben.client.get(portal(other.luna, '/members')).expect(404);
    await w.ben.client.get(portal('not-a-uuid', '/members')).expect(400);
  });

  it('keeps customer people off staff routes, and staff off the portal', async () => {
    const w = await workspace();

    // Review focus 2.
    for (const path of ['/pricing/quotes', '/catalog/materials', '/users', '/customers']) {
      const response = await w.ben.client.get(path);
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
    }

    await w.staff.get('/portal/me').expect(403);
    await w.staff.get(portal(w.luna, '/members')).expect(403);
  });

  it('lets owners and admins invite colleagues, but only an owner invites an owner', async () => {
    const w = await workspace();
    const cara = freshEmail('cara');

    // Ben is a buyer at Luna and a viewer at Sol: neither may invite.
    await w.ben.client.post(portal(w.luna, '/invitations'), { email: freshEmail('x'), role: 'viewer' }).expect(403);
    await w.ben.client.post(portal(w.sol, '/invitations'), { email: freshEmail('x'), role: 'viewer' }).expect(403);

    const invited = await w.anna.client.post(portal(w.luna, '/invitations'), { email: cara, role: 'admin' }).expect(201);
    expectDocumented(customerInvitationResponseSchema, invited.body);
    expect(notifier.lastCustomerInvitationFor(cara)).toMatchObject({ tenantId: w.tenantId, customerName: 'Luna Jewels' });
    const token = notifier.lastCustomerInvitationFor(cara)!.token;
    await request(app.getHttpServer())
      .post('/auth/customer-invitations/accept')
      .send({ token, name: 'Cara', password: PASSWORD })
      .expect(204);
    const asCara = (await w.personClient(cara)).client;

    await asCara.post(portal(w.luna, '/invitations'), { email: freshEmail('dan'), role: 'viewer' }).expect(201);
    await asCara.post(portal(w.luna, '/invitations'), { email: freshEmail('dan'), role: 'owner' }).expect(403);
    // Luna already has an owner, so even its owner cannot invite a second one.
    await w.anna.client.post(portal(w.luna, '/invitations'), { email: freshEmail('dan'), role: 'owner' }).expect(409);
  });

  it('changes roles within the rules, and hands over ownership', async () => {
    const w = await workspace();
    const cara = freshEmail('cara');
    await w.join(w.luna, cara, 'admin', 'Cara');
    const asCara = await w.personClient(cara);

    // An admin changes the roles of people below the owner, but never makes or unmakes the owner.
    const changed = await asCara.client.patch(portal(w.luna, `/members/${w.ben.id}`), { role: 'viewer' }).expect(200);
    expectDocumented(customerMemberResponseSchema, changed.body);
    await asCara.client.patch(portal(w.luna, `/members/${w.ben.id}`), { role: 'owner' }).expect(403);
    await asCara.client.patch(portal(w.luna, `/members/${w.anna.id}`), { role: 'buyer' }).expect(403);
    // A buyer or viewer changes nobody.
    await w.ben.client.patch(portal(w.luna, `/members/${asCara.id}`), { role: 'viewer' }).expect(403);
    // The owner cannot step down without handing over.
    await w.anna.client.patch(portal(w.luna, `/members/${w.anna.id}`), { role: 'admin' }).expect(409);

    await w.anna.client.patch(portal(w.luna, `/members/${w.ben.id}`), { role: 'owner' }).expect(200);
    expect(await roles(w.anna.client, w.luna)).toEqual({ [w.anna.email]: 'admin', [w.ben.email]: 'owner', [cara]: 'admin' });

    await w.anna.client.patch(portal(w.luna, `/members/${newId()}`), { role: 'buyer' }).expect(404);
    await w.ben.client.patch(portal(w.luna, `/members/${w.anna.id}`), { role: 'boss' }).expect(400);
  });

  it('removes people, never the owner, and lets anyone but the owner leave', async () => {
    const w = await workspace();
    const cara = freshEmail('cara');
    await w.join(w.luna, cara, 'admin', 'Cara');
    const asCara = await w.personClient(cara);

    await w.ben.client.delete(portal(w.luna, `/members/${asCara.id}`)).expect(403);
    await asCara.client.delete(portal(w.luna, `/members/${w.anna.id}`)).expect(409);
    await w.anna.client.delete(portal(w.luna, `/members/${w.anna.id}`)).expect(409);

    // Ben leaves Sol, where he is only a viewer; he still acts for Luna.
    await w.ben.client.delete(portal(w.sol, `/members/${w.ben.id}`)).expect(204);
    await asCara.client.delete(portal(w.luna, `/members/${w.ben.id}`)).expect(204);

    expect(await roles(w.anna.client, w.luna)).toEqual({ [w.anna.email]: 'owner', [cara]: 'admin' });
    await w.ben.client.get(portal(w.sol, '/members')).expect(404);
    expect(((await w.ben.client.get('/portal/me').expect(200)).body as { customers: unknown[] }).customers).toEqual([]);
    await w.anna.client.delete(portal(w.luna, `/members/${newId()}`)).expect(404);
  });

  it('stops everyone acting for a customer that staff disabled', async () => {
    const w = await workspace();

    await w.staff.patch(`/customers/${w.luna}`, { status: 'disabled' }).expect(200);

    await w.anna.client.get(portal(w.luna, '/members')).expect(404);
    await w.ben.client.get(portal(w.luna, '/members')).expect(404);
    const me = (await w.ben.client.get('/portal/me').expect(200)).body as { customers: { id: string }[] };
    expect(me.customers.map((customer) => customer.id)).toEqual([w.sol]);
  });
});
