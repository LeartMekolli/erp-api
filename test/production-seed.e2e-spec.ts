import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog } from '../src/cli/seed-catalog';
import { seedOrders } from '../src/cli/seed-orders';
import { seedPricing } from '../src/cli/seed-pricing';
import { seedProduction } from '../src/cli/seed-production';
import { seedWorkflows } from '../src/cli/seed-workflows';
import { PrismaService } from '../src/database/prisma.service';
import { CourierAccountService } from '../src/modules/couriers/courier-account.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

describe('production demo seed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let accounts: CourierAccountService;
  const createdTenants: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    accounts = moduleRef.get(CourierAccountService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('sets the courier account, a live-rate method, capacities and the job summary once, and a second run creates nothing', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await seedCatalog(prisma, tenant.id);
    await seedPricing(prisma, tenant.id);
    await seedWorkflows(prisma, tenant.id);
    await seedOrders(prisma, tenant.id);

    expect(await seedProduction({ prisma, accounts }, tenant.id)).toEqual({ account: 1, liveMethods: 1, capacities: 3, jobSummary: 1 });
    expect(await seedProduction({ prisma, accounts }, tenant.id)).toEqual({ account: 0, liveMethods: 0, capacities: 0, jobSummary: 0 });

    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const get = (path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

    expect((await get('/couriers/account').expect(200)).body).toMatchObject({ configured: true, mode: 'test', from_address: { name: 'Demo workshop' } });
    const methods = (await get('/orders/shipping-methods').expect(200)).body as { data: { key: string; price: string | null; live_rate: object | null }[] };
    expect(methods.data.find((method) => method.key === 'courier_live')).toMatchObject({
      price: null,
      live_rate: { carrier: 'FakeCarrier', service: 'standard' },
    });
    const capacities = (await get('/workflow/capacities').expect(200)).body as { data: { step_type: { key: string }; daily_pieces: number | null }[] };
    expect(
      Object.fromEntries(capacities.data.filter((row) => row.daily_pieces !== null).map((row) => [row.step_type.key, row.daily_pieces])),
    ).toEqual({ final_qc: 40, polishing: 25, finish: 25 });
    expect(((await get('/settings').expect(200)).body as { data: Record<string, unknown> }).data['ai.jobSummary']).toEqual({ enabled: true });
  });
});
