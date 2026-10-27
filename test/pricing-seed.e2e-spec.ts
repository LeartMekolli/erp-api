import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog } from '../src/cli/seed-catalog';
import { seedPricing } from '../src/cli/seed-pricing';
import { seedWorkflows } from '../src/cli/seed-workflows';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { measuredDesign } from './catalog-fixtures';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Staff {
  breakdown: { steps: { key: string }[] };
}

describe('pricing demo seed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

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

  it('creates the demo pricing once, on top of the demo catalog, and a second run creates nothing', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await seedCatalog(prisma, tenant.id);

    // 10 step types, a default price for each plus casting's own for gold, 3 category chains (the assembly's is one step).
    expect(await seedPricing(prisma, tenant.id)).toEqual({ stepTypes: 10, stepPrices: 11, chains: 3, tiers: 2, groups: 2, speeds: 3 });
    expect(await seedPricing(prisma, tenant.id)).toEqual({ stepTypes: 0, stepPrices: 0, chains: 0, tiers: 0, groups: 0, speeds: 0 });
    // Each speed promises working days; a quote holds for 4 hours.
    const speeds = await prisma.inTenant(tenant.id, (tx) => tx.deliverySpeed.findMany({ orderBy: { key: 'asc' } }));
    expect(speeds.map((speed) => [speed.key, speed.workingDays])).toEqual([
      ['express', 5],
      ['rush', 2],
      ['standard', 10],
    ]);
    expect((await prisma.inTenant(tenant.id, (tx) => tx.pricingProfile.findFirstOrThrow())).quoteValidHours).toBe(4);

    // 3 defects, final QC and packing, and one workflow per demo category.
    expect(await seedWorkflows(prisma, tenant.id)).toEqual({ defects: 3, stepTypes: 2, workflows: 3 });
    expect(await seedWorkflows(prisma, tenant.id)).toEqual({ defects: 0, stepTypes: 0, workflows: 0 });
  });

  it('seeds pricing that quotes the demo products', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    await seedCatalog(prisma, tenant.id);
    await seedPricing(prisma, tenant.id);
    await seedWorkflows(prisma, tenant.id);

    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const http = () => request(app.getHttpServer());
    const products = (
      (await http().get('/catalog/products').set('Authorization', `Bearer ${token}`).expect(200)).body as {
        data: { id: string; key: string }[];
      }
    ).data;
    const productId = (key: string) => products.find((product) => product.key === key)?.id ?? '';
    const design = await measuredDesign(prisma, tenant.id, owner.id);
    const quote = (body: object) => http().post('/pricing/quotes').set('Authorization', `Bearer ${token}`).send(body);
    const steps = async (quoteId: string) =>
      ((await http().get(`/pricing/quotes/${quoteId}`).set('Authorization', `Bearer ${token}`).expect(200)).body as Staff).breakdown.steps.map(
        (step) => step.key,
      );

    const cast = await quote({
      product_id: productId('custom_cast_part'),
      options: { material: 'silver_925', finish: 'polished' },
      size: { scale: '1.5' },
      file_version_id: design.versionId,
      quantity: 1,
    }).expect(201);
    const castQuote = (cast.body as { quote: { id: string; unit_price: string } }).quote;
    expect(await steps(castQuote.id)).toEqual(['print_pattern', 'casting_tree', 'casting', 'polishing']);

    const plated = await quote({
      product_id: productId('custom_cast_part'),
      options: { material: 'silver_925', finish: 'gold_plated' },
      size: { scale: '1.5' },
      file_version_id: design.versionId,
      quantity: 1,
      delivery_speed: 'rush',
      customer_group: 'trade',
    }).expect(201);
    expect(await steps((plated.body as { quote: { id: string } }).quote.id)).toContain('plating');

    const gold = await quote({
      product_id: productId('custom_cast_part'),
      options: { material: 'gold_18k', finish: 'raw' },
      file_version_id: design.versionId,
      quantity: 1,
    }).expect(201);
    expect(await steps((gold.body as { quote: { id: string } }).quote.id)).toEqual(['print_pattern', 'casting_tree', 'casting']);

    const print = await quote({
      product_id: productId('custom_resin_print'),
      options: { material: 'resin_standard', finish: 'polished' },
      file_version_id: design.versionId,
      quantity: 1,
    }).expect(201);
    expect(await steps((print.body as { quote: { id: string } }).quote.id)).toEqual(['print', 'cure', 'finish']);
  });
});
