import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog } from '../src/cli/seed-catalog';
import { seedPartners } from '../src/cli/seed-partners';
import { seedPricing } from '../src/cli/seed-pricing';
import { seedWorkflows } from '../src/cli/seed-workflows';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { measuredDesign } from './catalog-fixtures';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'demo-password-123';

interface Partner {
  id: string;
  name: string;
  status: string;
  agreement: object | null;
}

describe('partners demo seed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
  });

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

  async function seededTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await seedCatalog(prisma, tenant.id);
    await seedPricing(prisma, tenant.id);
    await seedWorkflows(prisma, tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    return { ...tenant, ownerId: owner.id, staff: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken) };
  }

  it('creates two approved partners with an owner each once, and a second run creates nothing', async () => {
    const tenant = await seededTenant();

    expect(await seedPartners(prisma, tenant.id, { password: PASSWORD })).toEqual({ counts: { partners: 2, people: 2 }, password: PASSWORD });
    expect(await seedPartners(prisma, tenant.id)).toEqual({ counts: { partners: 0, people: 0 }, password: null });

    const partners = ((await tenant.staff.get('/partners').expect(200)).body as { data: Partner[] }).data;
    expect(partners.map((partner) => [partner.name, partner.status, partner.agreement !== null]).sort()).toEqual([
      ['Layerline Prints', 'approved', true],
      ['Northcast Foundry', 'approved', true],
    ]);
  });

  it("lets Northcast's owner log in to its portal, set up with capabilities, offerings and the workspace's prices", async () => {
    const tenant = await seededTenant();
    await seedPartners(prisma, tenant.id, { password: PASSWORD });

    const login = await http().post('/auth/login').send({ email: 'owner@northcast.example.test', password: PASSWORD, workspace: tenant.slug }).expect(200);
    const owner = as((login.body as { access_token: string }).access_token);
    const me = (await owner.get('/partner-portal/me').expect(200)).body as { partners: { id: string; display_name: string; role: string; status: string }[] };
    expect(me.partners).toEqual([{ id: expect.any(String), display_name: 'Northcast Foundry', role: 'owner', status: 'approved' }]);
    const portal = `/partner-portal/partners/${me.partners[0].id}`;

    const setup = (await owner.get(`${portal}/setup`).expect(200)).body as {
      capabilities: { step_type: { key: string } }[];
      offerings: { key: string }[];
    };
    expect(setup.capabilities.map((capability) => capability.step_type.key)).toEqual([
      'print_pattern',
      'casting_tree',
      'casting',
      'polishing',
      'plating',
      'final_qc',
      'packing',
    ]);
    expect(setup.offerings.map((offering) => offering.key)).toEqual(expect.arrayContaining(['silver_925', 'polished']));
    // Copied from the workspace: every priced step it does.
    const prices = ((await owner.get(`${portal}/prices`).expect(200)).body as { data: { step_type_id: string }[] }).data;
    const keys = new Map(
      (await prisma.inTenant(tenant.id, (tx) => tx.stepType.findMany({ select: { id: true, key: true } }))).map((type) => [type.id, type.key]),
    );
    expect(new Set(prices.map((price) => keys.get(price.step_type_id)))).toEqual(
      new Set(['print_pattern', 'casting_tree', 'casting', 'polishing', 'plating']),
    );
  });

  it('makes the demo cast part a job Northcast can take and Layerline cannot', async () => {
    const tenant = await seededTenant();
    await seedPartners(prisma, tenant.id, { password: PASSWORD });
    const product = await prisma.inTenant(tenant.id, (tx) => tx.product.findFirstOrThrow({ where: { key: 'custom_cast_part' } }));
    const design = await measuredDesign(prisma, tenant.id, tenant.ownerId);

    const quoted = await tenant.staff
      .post('/pricing/quotes', {
        product_id: product.id,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        file_version_id: design.versionId,
        quantity: 10,
      })
      .expect(201);
    const quoteId = (quoted.body as { quote: { id: string } }).quote.id;
    const group = ((await tenant.staff.post('/workflow/groups', { quote_id: quoteId }).expect(201)).body as { id: string }).id;

    const eligible = (await tenant.staff.get(`/partners/eligible?group_id=${group}`).expect(200)).body as {
      data: { partner: { name: string } }[];
      ineligible: { partner: { name: string } }[];
    };
    expect(eligible.data.map((row) => row.partner.name)).toEqual(['Northcast Foundry']);
    expect(eligible.ineligible.map((row) => row.partner.name)).toEqual(['Layerline Prints']);
  });
});
