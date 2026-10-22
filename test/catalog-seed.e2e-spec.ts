import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog } from '../src/cli/seed-catalog';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { measuredDesign } from './catalog-fixtures';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Product {
  id: string;
  key: string;
  design_file: { version_id: string } | null;
}

describe('catalog demo seed', () => {
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

  it('creates the demo catalog once, and a second run creates nothing', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);

    expect(await seedCatalog(prisma, tenant.id)).toEqual({
      categories: 2,
      materials: 6,
      optionGroups: 2,
      optionValues: 9,
      optionRules: 2,
      products: 3,
    });
    expect(await seedCatalog(prisma, tenant.id)).toEqual({
      categories: 0,
      materials: 0,
      optionGroups: 0,
      optionValues: 0,
      optionRules: 0,
      products: 0,
    });
  });

  it('seeds a catalog the check accepts and refuses as configured', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const ringFile = await measuredDesign(prisma, tenant.id, owner.id);
    await seedCatalog(prisma, tenant.id, { ringVersionId: ringFile.versionId });

    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const http = () => request(app.getHttpServer());
    const products = (
      (await http().get('/catalog/products').set('Authorization', `Bearer ${token}`).expect(200)).body as { data: Product[] }
    ).data;
    expect(products.map((product) => product.key).sort()).toEqual(['custom_cast_part', 'custom_resin_print', 'ring_model_12']);
    const byKey = (key: string) => products.find((product) => product.key === key)?.id ?? '';
    expect(products.find((product) => product.key === 'ring_model_12')?.design_file).toMatchObject({
      version_id: ringFile.versionId,
    });

    const customerFile = await measuredDesign(prisma, tenant.id, owner.id);
    const check = (productId: string, body: object) =>
      http().post(`/catalog/products/${productId}/check`).set('Authorization', `Bearer ${token}`).send(body).expect(200);

    const cast = await check(byKey('custom_cast_part'), {
      options: { material: 'silver_925', finish: 'polished' },
      size: { scale: '1.5' },
      file_version_id: customerFile.versionId,
    });
    expect(cast.body).toMatchObject({ accepted: true, material: { key: 'silver_925' } });

    const goldOnBrass = await check(byKey('custom_cast_part'), {
      options: { material: 'brass', finish: 'gold_plated' },
      file_version_id: customerFile.versionId,
    });
    expect(goldOnBrass.body).toMatchObject({ accepted: false, reasons: [{ code: 'rule_requires' }] });

    const polishedNylon = await check(byKey('custom_resin_print'), {
      options: { material: 'nylon_pa12', finish: 'polished' },
      file_version_id: customerFile.versionId,
    });
    expect(polishedNylon.body).toMatchObject({ accepted: false, reasons: [{ code: 'rule_excludes' }] });

    const ring = await check(byKey('ring_model_12'), { options: { material: 'gold_18k' }, size: { named: 'S' } });
    expect(ring.body).toMatchObject({ accepted: true, scale: '0.9', material: { key: 'gold_18k' } });
  });
});
