import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConfigService, createConfigService } from '../src/config/config.service';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { FakeMetalPriceProvider } from '../src/modules/catalog/price-feed/fake.provider';
import { METAL_PRICE_PROVIDER } from '../src/modules/catalog/price-feed/metal-price-provider';
import type { MetalPriceProvider } from '../src/modules/catalog/price-feed/metal-price-provider';
import { PriceSnapshotHandler } from '../src/modules/catalog/price-feed/price-snapshot.handler';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

/** Snapshots are platform-wide and outlive test runs, so this run prices a metal of its own. */
const RUN_METAL = `testmetal_${randomBytes(4).toString('hex')}`;

/** The fake provider plus this run's metal at 0.80 per gram, unless a test makes it fail. */
class SwitchableProvider implements MetalPriceProvider {
  readonly name = 'test';
  failing = false;
  private readonly fake = new FakeMetalPriceProvider();

  latest(currency: string): ReturnType<MetalPriceProvider['latest']> {
    if (this.failing) return Promise.reject(new Error('provider down'));
    return this.fake
      .latest(currency)
      .then((prices) => [...prices, { metal: RUN_METAL, pricePerGram: new Prisma.Decimal('0.80') }]);
  }
}
const provider = new SwitchableProvider();

describe('catalog: metal price feed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let handler: PriceSnapshotHandler;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;

  const http = () => request(app.getHttpServer());

  async function tenantWithSilver(currency: string): Promise<{ id: string; token: string; materialId: string }> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await prisma.inTenant(tenant.id, (tx) => tx.tenant.update({ where: { id: tenant.id }, data: { defaultCurrency: currency } }));
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const created = await http()
      .post('/catalog/materials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        key: 'silver_925',
        name: 'Silver 925',
        priced_unit: 'g',
        price_source: 'feed',
        feed_metal: RUN_METAL,
        addon_percent: '8',
        addon_amount: '0.20',
        fallback_price: '0.85',
      })
      .expect(201);
    return { id: tenant.id, token, materialId: (created.body as { id: string }).id };
  }

  const material = async (tenant: { token: string; materialId: string }) =>
    (await http().get(`/catalog/materials/${tenant.materialId}`).set('Authorization', `Bearer ${tenant.token}`).expect(200))
      .body as { current_price: { unit_price: string; source: string } };

  const staleNotices = (tenantId: string) =>
    prisma.inTenant(tenantId, (tx) => tx.notification.count({ where: { eventKey: 'material.price.stale' } }));

  beforeAll(async () => {
    // Raising a notification queues its dispatch; keep those jobs out of other specs' queues.
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Only the most common workspace currency is fetched.
      .overrideProvider(ConfigService)
      .useValue(createConfigService({ ...process.env, METAL_PRICE_MAX_CURRENCIES: '1' }))
      .overrideProvider(METAL_PRICE_PROVIDER)
      .useValue(provider)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    handler = moduleRef.get(PriceSnapshotHandler);
  });

  afterAll(async () => {
    process.env.QUEUE_PREFIX = previousPrefix;
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('stores snapshots for the capped currencies and prices feed materials from them', async () => {
    const eur = await tenantWithSilver('EUR');
    const usd = await tenantWithSilver('USD');
    expect((await material(eur)).current_price).toMatchObject({ source: 'fallback', unit_price: '0.85' });

    await handler.handle();

    // Fake silver is 0.80 per gram: 0.80 × 1.08 + 0.20.
    expect((await material(eur)).current_price).toMatchObject({ source: 'feed', unit_price: '1.064' });
    const snapshotCurrencies = await prisma.metalPriceSnapshot.findMany({
      where: { metal: RUN_METAL },
      distinct: ['currency'],
      select: { currency: true },
    });
    expect(snapshotCurrencies.map((row) => row.currency)).toEqual(['EUR']);

    // USD is over the cap: it keeps its fallback, and its staff hear about it once a day.
    expect((await material(usd)).current_price).toMatchObject({ source: 'fallback' });
    expect(await staleNotices(usd.id)).toBe(1);
    expect(await staleNotices(eur.id)).toBe(0);

    await handler.handle();
    expect(await staleNotices(usd.id)).toBe(1);
  });

  it('keeps the last good snapshots when the provider fails, and does not fail the run', async () => {
    const eur = await tenantWithSilver('EUR');
    await handler.handle();
    const before = await prisma.metalPriceSnapshot.count({ where: { metal: RUN_METAL } });

    provider.failing = true;
    try {
      await expect(handler.handle()).resolves.toBeUndefined();
    } finally {
      provider.failing = false;
    }

    expect(await prisma.metalPriceSnapshot.count({ where: { metal: RUN_METAL } })).toBe(before);
    expect((await material(eur)).current_price).toMatchObject({ source: 'feed' });
  });
});
