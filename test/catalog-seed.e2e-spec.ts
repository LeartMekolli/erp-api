import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog, seedPlaceholderDesign } from '../src/cli/seed-catalog';
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

    // The pendant set adds a category, the bought chain (a material no option picks) and three products:
    // the pendant, the bail and the set made of them.
    expect(await seedCatalog(prisma, tenant.id)).toEqual({
      categories: 3,
      materials: 7,
      optionGroups: 2,
      optionValues: 9,
      optionRules: 2,
      products: 6,
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

  it('makes the pendant set of a pendant and a bail, ready-made, with the design given', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });

    // One placeholder design, found again by a second run.
    const design = await seedPlaceholderDesign(prisma, tenant.id, owner.id);
    expect(await seedPlaceholderDesign(prisma, tenant.id, owner.id)).toBe(design);
    const version = await prisma.inTenant(tenant.id, (tx) => tx.fileVersion.findUniqueOrThrow({ where: { id: design }, include: { measures: true } }));
    expect(version.status).toBe('measured');
    expect(version.measures.map((measure) => measure.type).sort()).toEqual(
      ['bounding_box_x', 'bounding_box_y', 'bounding_box_z', 'surface_area', 'volume'],
    );

    await seedCatalog(prisma, tenant.id, { partVersionId: design });
    const products = await prisma.inTenant(tenant.id, (tx) =>
      tx.product.findMany({
        where: { key: { in: ['pendant_part', 'bail_part', 'pendant_set'] } },
        include: { parts: { orderBy: { position: 'asc' }, include: { part: { select: { key: true } } } }, material: { select: { key: true } } },
      }),
    );
    const byKey = (key: string) => products.find((product) => product.key === key)!;
    expect(products.map((product) => [product.key, product.kind, product.published]).sort()).toEqual([
      ['bail_part', 'ready_made', true],
      ['pendant_set', 'assembly', true],
      ['pendant_part', 'ready_made', true],
    ].sort());
    // The parts carry the design; the bail is fixed in size and in material; the set has none of its own.
    expect([byKey('pendant_part').fileVersionId, byKey('bail_part').fileVersionId]).toEqual([design, design]);
    expect(byKey('pendant_part').sizing).toMatchObject({ mode: 'named', sizes: [{ key: 'S' }, { key: 'M' }, { key: 'L' }] });
    expect(byKey('bail_part')).toMatchObject({ sizing: { mode: 'none' }, material: { key: 'resin_standard' } });
    expect(byKey('pendant_set').fileVersionId).toBeNull();
    expect(byKey('pendant_set').parts.map((part) => [part.part.key, part.quantity, part.size])).toEqual([
      ['pendant_part', 1, { named: 'M' }],
      ['bail_part', 1, null],
    ]);
    expect(await seedCatalog(prisma, tenant.id, { partVersionId: design })).toMatchObject({ products: 0, materials: 0, categories: 0 });
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
    expect(products.map((product) => product.key).sort()).toEqual([
      'bail_part',
      'custom_cast_part',
      'custom_resin_print',
      'pendant_part',
      'pendant_set',
      'ring_model_12',
    ]);
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
