import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { customerResponseSchema } from '../src/modules/customers/customer-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { hashPassword } from '../src/modules/identity/passwords';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Customer {
  id: string;
  name: string;
  status: string;
  customer_group: { id: string; key: string; name: string } | null;
  member_count: number;
}

describe('customers: organisations managed by staff', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const as = (token: string) => ({
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    });
    return {
      id: tenant.id,
      owner: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken),
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
    };
  }

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

  it('creates, lists, reads and edits customer organisations, and audits changes', async () => {
    const tenant = await freshTenant();
    const trade = (
      (await tenant.owner.post('/pricing/customer-groups', { key: 'trade', name: 'Trade', percent: '-10' }).expect(201)).body as {
        id: string;
      }
    ).id;

    const created = await tenant.owner.post('/customers', { name: 'Luna Jewels', customer_group_id: trade }).expect(201);
    expectDocumented(customerResponseSchema, created.body);
    expect(created.body).toMatchObject({
      name: 'Luna Jewels',
      status: 'active',
      customer_group: { id: trade, key: 'trade', name: 'Trade' },
      member_count: 0,
    });
    const luna = (created.body as Customer).id;
    await tenant.owner.post('/customers', { name: 'Mira Studio' }).expect(201);

    const listed = await tenant.owner.get('/customers').expect(200);
    const customers = (listed.body as { data: Customer[]; next_cursor: string | null }).data;
    customers.forEach((customer) => expectDocumented(customerResponseSchema, customer));
    // Newest first.
    expect(customers.map((customer) => customer.name)).toEqual(['Mira Studio', 'Luna Jewels']);

    const read = await tenant.owner.get(`/customers/${luna}`).expect(200);
    expect(read.body).toEqual(created.body);

    const disabled = await tenant.owner.patch(`/customers/${luna}`, { status: 'disabled', customer_group_id: null }).expect(200);
    expectDocumented(customerResponseSchema, disabled.body);
    expect(disabled.body).toMatchObject({ status: 'disabled', customer_group: null });
    await tenant.owner.patch(`/customers/${luna}`, { status: 'active', name: 'Luna Jewels Ltd' }).expect(200);

    const entries = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'customer.changed', subjectId: luna }, orderBy: { id: 'asc' } }),
    );
    expect(entries).toHaveLength(3);
    expect(entries[2]).toMatchObject({ before: { name: 'Luna Jewels', status: 'disabled' }, after: { name: 'Luna Jewels Ltd', status: 'active' } });
  });

  it('refuses malformed customers and unknown groups', async () => {
    const tenant = await freshTenant();
    for (const body of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(201) }, {}, { name: 'Luna', customer_group_id: 'nope' }]) {
      const response = await tenant.owner.post('/customers', body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    await tenant.owner.post('/customers', { name: 'Luna', customer_group_id: newId() }).expect(404);
    const luna = ((await tenant.owner.post('/customers', { name: 'Luna' }).expect(201)).body as Customer).id;
    await tenant.owner.patch(`/customers/${luna}`, { status: 'archived' }).expect(400);
  });

  it('lets members read customers but not change them, and keeps customers to the workspace', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const luna = ((await a.owner.post('/customers', { name: 'Luna' }).expect(201)).body as Customer).id;
    const otherGroup = (
      (await b.owner.post('/pricing/customer-groups', { key: 'vip', name: 'VIP', percent: '-5' }).expect(201)).body as { id: string }
    ).id;

    await a.member.get('/customers').expect(200);
    await a.member.get(`/customers/${luna}`).expect(200);
    await a.member.post('/customers', { name: 'Sol' }).expect(403);
    await a.member.patch(`/customers/${luna}`, { name: 'Sol' }).expect(403);

    await b.owner.get(`/customers/${luna}`).expect(404);
    await b.owner.patch(`/customers/${luna}`, { name: 'Taken' }).expect(404);
    await a.owner.post('/customers', { name: 'Sol', customer_group_id: otherGroup }).expect(404);
    expect(((await b.owner.get('/customers').expect(200)).body as { data: unknown[] }).data).toEqual([]);
  });

  it('keeps customer people out of the staff user list', async () => {
    const tenant = await freshTenant();
    const passwordHash = await hashPassword('a-long-test-password');
    await prisma.inTenant(tenant.id, (tx) =>
      tx.user.create({
        data: { email: 'anna@luna.example.test', passwordHash, name: 'Anna', locale: 'en', kind: 'customer' },
      }),
    );

    const users = ((await tenant.owner.get('/users').expect(200)).body as { data: { email: string }[] }).data;
    expect(users.map((user) => user.email)).not.toContain('anna@luna.example.test');
    expect(users).toHaveLength(2);
  });
});
