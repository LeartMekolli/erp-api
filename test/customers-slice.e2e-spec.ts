import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog } from '../src/cli/seed-catalog';
import { seedPricing } from '../src/cli/seed-pricing';
import { seedWorkflows } from '../src/cli/seed-workflows';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { cube, stl } from './stl';
import { putToSignedUrl } from './storage';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

const PASSWORD = 'a-long-customer-password';

interface Summary {
  id: string;
  lines: { label: string; amount: string }[];
  unit_price: string;
}

/**
 * The Customers spec's walkthrough, end to end over HTTP on the demo catalog and pricing: staff
 * create Luna and invite Anna; Anna invites Ben; Ben uploads his design, quotes it, saves it as
 * Luna's own product and quotes that again; Mira, another customer, sees none of it.
 */
describe('customers: the walkthrough', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
  });

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_NOTIFIER)
      .useValue(notifier)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    worker = await startTestWorker();
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app?.close();
  });

  it('runs from inviting the first person to quoting a saved product, and keeps it all to Luna', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await seedCatalog(prisma, tenant.id);
    await seedPricing(prisma, tenant.id);
    await seedWorkflows(prisma, tenant.id);
    const staffUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, staffUser.id)).accessToken);
    const trade = await prisma.inTenant(tenant.id, (tx) => tx.customerGroup.findFirstOrThrow({ where: { key: 'trade' } }));

    const accept = async (email: string, name: string) => {
      const token = notifier.lastCustomerInvitationFor(email)!.token;
      await http().post('/auth/customer-invitations/accept').send({ token, name, password: PASSWORD }).expect(204);
    };
    const login = async (email: string) => {
      const response = await http().post('/auth/login').send({ email, password: PASSWORD, workspace: tenant.slug }).expect(200);
      return as((response.body as { access_token: string }).access_token);
    };

    // Staff create Luna, in the trade group, and invite Anna as its owner.
    const luna = ((await staff.post('/customers', { name: 'Luna Jewels', customer_group_id: trade.id }).expect(201)).body as { id: string }).id;
    await staff.post(`/customers/${luna}/invitations`, { email: 'anna@luna.example.test', role: 'owner' }).expect(201);
    await accept('anna@luna.example.test', 'Anna');
    const anna = await login('anna@luna.example.test');

    // Anna invites Ben as a buyer.
    await anna.post(`/portal/customers/${luna}/invitations`, { email: 'ben@luna.example.test', role: 'buyer' }).expect(201);
    await accept('ben@luna.example.test', 'Ben');
    const ben = await login('ben@luna.example.test');
    const portal = (rest: string) => `/portal/customers/${luna}${rest}`;

    // Ben uploads his design; the worker measures it.
    const design = stl(cube(10), 'binary');
    const started = (
      await ben
        .post(portal('/files'), { kind: 'design', name: 'moon.stl', content_type: 'model/stl', size: design.length, declared_unit: 'mm' })
        .expect(201)
    ).body as { file: { id: string }; version: { id: string }; upload: { url: string; headers: Record<string, string> } };
    const put = await putToSignedUrl(started.upload.url, design, started.upload.headers);
    await put.arrayBuffer();
    expect(put.status).toBe(200);
    await ben.post(portal(`/files/${started.file.id}/versions/${started.version.id}/complete`)).expect(200);
    await waitFor(async () => {
      const row = await prisma.inTenant(tenant.id, (tx) => tx.fileVersion.findUniqueOrThrow({ where: { id: started.version.id } }));
      return row.status === 'measured' ? row : undefined;
    });

    // Ben quotes the published cast part with it.
    const products = ((await ben.get(portal('/products')).expect(200)).body as { data: { id: string; name: string }[] }).data;
    const castPart = products.find((product) => product.name === 'Custom cast part')!;
    const choice = { options: { material: 'silver_925', finish: 'polished' }, size: { scale: '1.5' }, quantity: 1 };
    const quoted = await ben
      .post(portal('/quotes'), { ...choice, product_id: castPart.id, file_version_id: started.version.id })
      .expect(201);
    const quote = (quoted.body as { quote: Summary }).quote;
    // Only grouped lines, adding up to the price, with Luna's discount.
    expect(quote.lines.map((line) => line.label)).toEqual(['material', 'making', 'finishing', 'your_discount']);
    expect(quote.lines.every((line) => Object.keys(line).sort().join() === 'amount,label')).toBe(true);
    const cents = quote.lines.reduce((sum, line) => sum + Math.round(Number(line.amount) * 100), 0);
    expect(cents).toBe(Math.round(Number(quote.unit_price) * 100));

    // He saves it as Luna's own product and quotes that again: the same price.
    const saved = (await ben.post(portal('/products'), { quote_id: quote.id, name: 'Luna Moon Ring' }).expect(201)).body as {
      id: string;
    };
    const again = await ben.post(portal('/quotes'), { ...choice, product_id: saved.id }).expect(201);
    expect((again.body as { quote: Summary }).quote.unit_price).toBe(quote.unit_price);
    const annaSees = ((await anna.get(portal('/quotes')).expect(200)).body as { data: unknown[] }).data;
    expect(annaSees).toHaveLength(2);

    // Mira, another customer of the workspace, sees none of it.
    const mira = ((await staff.post('/customers', { name: 'Mira Studio' }).expect(201)).body as { id: string }).id;
    await staff.post(`/customers/${mira}/invitations`, { email: 'mira@mira.example.test', role: 'owner' }).expect(201);
    await accept('mira@mira.example.test', 'Mira');
    const miraClient = await login('mira@mira.example.test');
    const miraPortal = (rest: string) => `/portal/customers/${mira}${rest}`;
    const miraProducts = ((await miraClient.get(miraPortal('/products')).expect(200)).body as { data: { name: string }[] }).data;
    expect(miraProducts.map((product) => product.name)).not.toContain('Luna Moon Ring');
    expect(((await miraClient.get(miraPortal('/quotes')).expect(200)).body as { data: unknown[] }).data).toEqual([]);
    expect(((await miraClient.get(miraPortal('/files')).expect(200)).body as { data: unknown[] }).data).toEqual([]);
    await miraClient.get(portal(`/quotes/${quote.id}`)).expect(404);
    await miraClient.get(miraPortal(`/quotes/${quote.id}`)).expect(404);
    await miraClient.post(miraPortal('/quotes'), { ...choice, product_id: saved.id }).expect(404);
  });
});
