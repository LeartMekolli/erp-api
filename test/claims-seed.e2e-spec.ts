import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedClaims } from '../src/cli/seed-claims';
import { PrismaService } from '../src/database/prisma.service';
import { DEFAULT_CLAIM_SETTINGS } from '../src/modules/claims/claim-settings';
import { createTestTenant, deleteTestTenants } from './factories';

const PASSWORD = 'demo-password-123';

describe('claims demo seed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdTenants: string[] = [];

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

  it('sets the claim defaults, an accountant and their monthly files once, and a second run creates nothing', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);

    expect(await seedClaims(prisma, tenant.id, { password: PASSWORD })).toEqual({ counts: { claims: 1, schedules: 1, accountants: 1 }, password: PASSWORD });
    expect(await seedClaims(prisma, tenant.id)).toEqual({ counts: { claims: 0, schedules: 0, accountants: 0 }, password: null });

    const { accountant, settings } = await prisma.inTenant(tenant.id, async (tx) => ({
      accountant: await tx.user.findFirstOrThrow({ where: { email: 'accountant@demo.example.test' }, include: { roles: { include: { role: true } } } }),
      settings: await tx.tenantSetting.findMany({ where: { key: { in: ['orders.claims', 'reports.schedules'] } }, orderBy: { key: 'asc' } }),
    }));
    expect(accountant.roles.map((one) => [one.role.name, one.role.isSystem])).toEqual([['accountant', true]]);
    expect(settings.map((row) => row.value)).toEqual([
      DEFAULT_CLAIM_SETTINGS,
      { accounting: { enabled: true, recipientUserIds: [accountant.id] }, top_customers: { enabled: false, recipientUserIds: [] } },
    ]);

    // The accountant signs in with the password and may download exports.
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'accountant@demo.example.test', password: PASSWORD, workspace: tenant.slug })
      .expect(200);
    const token = (login.body as { access_token: string }).access_token;
    await request(app.getHttpServer()).get('/reports/exports').set('Authorization', `Bearer ${token}`).expect(200);
  });
});
