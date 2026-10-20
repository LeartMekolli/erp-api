import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { ERROR_REPORTER } from '../src/common/reporting/reporting.module';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { hashPassword } from '../src/modules/identity/passwords';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

describe('platform diagnostics', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminId: string;
  let adminToken: string;
  let tenantToken: string;
  const createdTenants: string[] = [];
  const reporter = { report: jest.fn() };

  const trigger = (token?: string) => {
    const call = request(app.getHttpServer()).post('/platform/diagnostics/error');
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ERROR_REPORTER)
      .useValue(reporter)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    const tokens = moduleRef.get(AccessTokenService);

    const admin = await prisma.platformAdmin.create({
      data: {
        email: `diagnostics-${newId()}@example.test`,
        passwordHash: await hashPassword('platform-admin-password'),
        name: 'Diagnostics Admin',
      },
    });
    adminId = admin.id;
    adminToken = (await tokens.issueForPlatformAdmin(admin.id)).accessToken;

    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    tenantToken = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
  });

  beforeEach(() => reporter.report.mockClear());

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await prisma.platformAdmin.delete({ where: { id: adminId } });
    await app.close();
  });

  it('answers 500 for a platform admin, and reports the error', async () => {
    const response = await trigger(adminToken).expect(500);

    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(reporter.report).toHaveBeenCalledTimes(1);
    const [error] = reporter.report.mock.calls[0] as [Error];
    expect(error.message).toMatch(/diagnostics/i);
  });

  it('refuses a tenant user with 403, and an anonymous caller with 401, without reporting', async () => {
    await trigger(tenantToken).expect(403);
    await trigger().expect(401);

    expect(reporter.report).not.toHaveBeenCalled();
  });
});
