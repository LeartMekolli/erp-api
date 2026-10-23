import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog } from '../src/cli/seed-catalog';
import { seedCustomers } from '../src/cli/seed-customers';
import { seedPricing } from '../src/cli/seed-pricing';
import { PrismaService } from '../src/database/prisma.service';
import { measuredDesign } from './catalog-fixtures';
import { createTestTenant, deleteTestTenants } from './factories';

const PASSWORD = 'demo-password-123';

describe('customers demo seed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  async function seededTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await seedCatalog(prisma, tenant.id);
    await seedPricing(prisma, tenant.id);
    return tenant;
  }

  it('creates two customers and three people once, and a second run creates nothing', async () => {
    const tenant = await seededTenant();

    expect(await seedCustomers(prisma, tenant.id, { password: PASSWORD })).toEqual({
      counts: { customers: 2, people: 3 },
      password: PASSWORD,
    });
    expect(await seedCustomers(prisma, tenant.id)).toEqual({ counts: { customers: 0, people: 0 }, password: null });
  });

  it('makes up a password when none is given, and returns it only when someone was created', async () => {
    const tenant = await seededTenant();

    const first = await seedCustomers(prisma, tenant.id);
    expect(first.counts).toEqual({ customers: 2, people: 3 });
    expect(first.password).toEqual(expect.stringMatching(/^.{16,}$/));
    await http().post('/auth/login').send({ email: 'mira@mira.example.test', password: first.password, workspace: tenant.slug }).expect(200);
  });

  it('lets Ben log in, see the demo cast part, and quote it with his file at the trade discount', async () => {
    const tenant = await seededTenant();
    await seedCustomers(prisma, tenant.id, { password: PASSWORD });

    const login = await http().post('/auth/login').send({ email: 'ben@luna.example.test', password: PASSWORD, workspace: tenant.slug }).expect(200);
    const token = (login.body as { access_token: string }).access_token;
    const as = (path: string) => http().get(path).set('Authorization', `Bearer ${token}`);

    const me = (await as('/portal/me').expect(200)).body as { user: { id: string }; customers: { id: string; name: string; role: string }[] };
    expect(me.customers).toEqual([{ id: expect.any(String), name: 'Luna Jewels', role: 'buyer' }]);
    const luna = me.customers[0].id;

    const products = ((await as(`/portal/customers/${luna}/products`).expect(200)).body as { data: { id: string; name: string }[] }).data;
    const castPart = products.find((product) => product.name === 'Custom cast part');
    expect(castPart).toBeDefined();

    const design = await measuredDesign(prisma, tenant.id, me.user.id, { customerId: luna });
    const quoted = await http()
      .post(`/portal/customers/${luna}/quotes`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        product_id: castPart!.id,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        file_version_id: design.versionId,
        quantity: 1,
      })
      .expect(201);
    expect((quoted.body as { quote: { lines: { label: string }[] } }).quote.lines.map((line) => line.label)).toContain('your_discount');
  });
});
