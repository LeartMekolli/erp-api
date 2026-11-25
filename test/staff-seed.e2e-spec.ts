import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog } from '../src/cli/seed-catalog';
import { seedPricing } from '../src/cli/seed-pricing';
import { seedStaff } from '../src/cli/seed-staff';
import { seedWorkflows } from '../src/cli/seed-workflows';
import { PrismaService } from '../src/database/prisma.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'demo-password-123';

describe('staff demo seed', () => {
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

  it('gives the acting user the Final QC skill and adds a floor member without it, once', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await seedCatalog(prisma, tenant.id);
    await seedPricing(prisma, tenant.id);
    await seedWorkflows(prisma, tenant.id);
    const acting = await createTestUser(prisma, tenant.id, { roles: [] });

    expect(await seedStaff(prisma, tenant.id, { actingUserId: acting.id, password: PASSWORD })).toEqual({
      counts: { skills: 1, members: 1 },
      password: PASSWORD,
    });
    expect(await seedStaff(prisma, tenant.id, { actingUserId: acting.id })).toEqual({ counts: { skills: 0, members: 0 }, password: null });

    const { floor, held } = await prisma.inTenant(tenant.id, async (tx) => ({
      floor: await tx.user.findFirstOrThrow({
        where: { email: 'floor@demo.example.test' },
        include: { roles: { include: { role: true } }, skills: true },
      }),
      held: await tx.userSkill.findMany({ where: { userId: acting.id }, include: { skill: true } }),
    }));
    expect(floor.kind).toBe('staff');
    expect(floor.roles.map((one) => [one.role.name, one.role.isSystem])).toEqual([['member', true]]);
    expect(floor.skills).toEqual([]);
    expect(held.map((row) => [row.skill.name, row.expiresOn])).toEqual([['Final QC', null]]);

    // The floor member signs in with the password.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'floor@demo.example.test', password: PASSWORD, workspace: tenant.slug })
      .expect(200);
  });

  it('refuses to run before the workflows are seeded', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const acting = await createTestUser(prisma, tenant.id, { roles: [] });

    await expect(seedStaff(prisma, tenant.id, { actingUserId: acting.id })).rejects.toThrow(/Final QC/);
  });
});
