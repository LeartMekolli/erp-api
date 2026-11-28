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
      counts: { skills: 1, members: 1, people: 2, invitations: 2, roles: 1 },
      password: PASSWORD,
    });
    expect(await seedStaff(prisma, tenant.id, { actingUserId: acting.id })).toEqual({
      counts: { skills: 0, members: 0, people: 0, invitations: 0, roles: 0 },
      password: null,
    });

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

  it('seeds a limited lead, a deactivated person, invitations and skills for Settings > People', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await seedCatalog(prisma, tenant.id);
    await seedPricing(prisma, tenant.id);
    await seedWorkflows(prisma, tenant.id);
    const acting = await createTestUser(prisma, tenant.id, { roles: [] });
    await seedStaff(prisma, tenant.id, { actingUserId: acting.id, password: PASSWORD });

    const found = await prisma.inTenant(tenant.id, async (tx) => ({
      role: await tx.role.findFirstOrThrow({ where: { name: 'Production lead' }, include: { permissions: true, users: { include: { user: true } } } }),
      lead: await tx.user.findFirstOrThrow({
        where: { email: 'lead@demo.example.test' },
        include: { roles: { include: { role: true } }, skills: { include: { skill: true } } },
      }),
      former: await tx.user.findFirstOrThrow({ where: { email: 'former@demo.example.test' } }),
      invitations: await tx.invitation.findMany({ where: { email: { in: ['waiting@demo.example.test', 'expired@demo.example.test'] } } }),
    }));

    expect(found.role.isSystem).toBe(false);
    expect(found.role.permissions.map((row) => row.permission).sort()).toEqual([
      'order.read',
      'role.assign',
      'role.read',
      'user.read',
      'workflow.move',
      'workflow.read',
    ]);
    expect(found.role.users.map((row) => row.user.email)).toEqual(['lead@demo.example.test']);
    expect(found.lead.kind).toBe('staff');
    expect(found.lead.roles.map((one) => one.role.name)).toEqual(['Production lead']);
    expect(found.former.status).toBe('deactivated');
    expect(found.former.kind).toBe('staff');

    const soon = found.lead.skills.find((row) => row.skill.name === 'Final QC');
    const days = (soon!.expiresOn!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThanOrEqual(30);
    const archived = found.lead.skills.find((row) => row.skill.archivedAt !== null);
    expect(archived).toBeDefined();

    const waiting = found.invitations.find((row) => row.email === 'waiting@demo.example.test')!;
    const expired = found.invitations.find((row) => row.email === 'expired@demo.example.test')!;
    expect([waiting.acceptedAt, waiting.cancelledAt]).toEqual([null, null]);
    expect(waiting.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect([expired.acceptedAt, expired.cancelledAt]).toEqual([null, null]);
    expect(expired.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it('refuses to run before the workflows are seeded', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const acting = await createTestUser(prisma, tenant.id, { roles: [] });

    await expect(seedStaff(prisma, tenant.id, { actingUserId: acting.id })).rejects.toThrow(/Final QC/);
  });
});
