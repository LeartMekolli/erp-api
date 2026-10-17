import { Controller, Get, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import type { AuthContext, PlatformAuth } from '../src/modules/identity/auth-context';
import {
  CurrentAuth,
  CurrentPlatformAdmin,
  CurrentTenant,
} from '../src/modules/identity/auth-context';
import {
  Authenticated,
  Public,
  RequirePermission,
} from '../src/modules/identity/route-markers';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

@Controller('guard-fixture')
class GuardFixtureController {
  @Public()
  @Get('public')
  open(): { ok: true } {
    return { ok: true };
  }

  @Authenticated()
  @Get('authenticated')
  authenticated(@CurrentAuth() auth: AuthContext): { scope: string } {
    return { scope: auth.scope };
  }

  @RequirePermission('settings.write')
  @Get('tenant-permission')
  tenantPermission(@CurrentTenant() tenantId: string): { tenantId: string } {
    return { tenantId };
  }

  @RequirePermission('platform.tenant.read')
  @Get('platform-permission')
  platformPermission(@CurrentPlatformAdmin() admin: PlatformAuth): { id: string } {
    return { id: admin.platformAdminId };
  }

  @Get('unmarked')
  unmarked(): { ok: true } {
    return { ok: true };
  }
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('auth guard', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let tenant: { id: string; slug: string };
  let suspended: { id: string; slug: string };
  let ownerToken: string;
  let memberToken: string;
  let platformToken: string;
  let platformAdminId: string;

  const get = (path: string, token?: string) => {
    const call = request(app.getHttpServer()).get(`/guard-fixture/${path}`);
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [GuardFixtureController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);

    tenant = await createTestTenant(prisma);
    suspended = await createTestTenant(prisma, { status: 'suspended' });

    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    ownerToken = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    memberToken = (await tokens.issueForUser(tenant.id, member.id)).accessToken;

    const admin = await prisma.platformAdmin.create({
      data: { email: `guard-${newId()}@example.test`, passwordHash: 'x', name: 'Guard Admin' },
    });
    platformAdminId = admin.id;
    platformToken = (await tokens.issueForPlatformAdmin(admin.id)).accessToken;
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, [tenant.id, suspended.id]);
    await prisma.platformAdmin.delete({ where: { id: platformAdminId } });
    await app.close();
  });

  it('lets a public route through without a token', async () => {
    await get('public').expect(200, { ok: true });
  });

  it('requires a valid token on an authenticated route', async () => {
    await get('authenticated').expect(401);
    await get('authenticated', 'garbage').expect(401);
    await get('authenticated', ownerToken).expect(200, { scope: 'tenant' });
    await get('authenticated', platformToken).expect(200, { scope: 'platform' });
  });

  it('rejects a token signed with another secret', async () => {
    const forged = new JwtService({ secret: 'another_secret_that_is_32_chars_long!' }).sign(
      { tid: tenant.id, scope: 'tenant', jti: newId() },
      { algorithm: 'HS256', audience: 'erp-api', subject: newId(), expiresIn: 900 },
    );

    await get('authenticated', forged).expect(401);
  });

  it('rejects an unsigned token (alg none)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
      sub: newId(),
      tid: tenant.id,
      scope: 'tenant',
      jti: newId(),
      aud: 'erp-api',
      iat: now,
      exp: now + 900,
    })}.`;

    await get('authenticated', unsigned).expect(401);
  });

  it('denies an unmarked route even to an owner (spec 8.4)', async () => {
    await get('unmarked', ownerToken).expect(403);
  });

  it('checks the permission on a permission route', async () => {
    await get('tenant-permission', ownerToken).expect(200, { tenantId: tenant.id });
    await get('tenant-permission', memberToken).expect(403);
    await get('tenant-permission').expect(401);
  });

  it('keeps platform and tenant tokens to their own routes', async () => {
    await get('platform-permission', platformToken).expect(200, { id: platformAdminId });
    await get('platform-permission', ownerToken).expect(403);
    await get('tenant-permission', platformToken).expect(403);
  });

  it('refuses a token for a user that does not exist in the tenant', async () => {
    const { accessToken } = await tokens.issueForUser(tenant.id, newId());

    await get('authenticated', accessToken).expect(401);
  });

  it("refuses a deactivated user's still-valid token", async () => {
    const user = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const { accessToken } = await tokens.issueForUser(tenant.id, user.id);
    await get('authenticated', accessToken).expect(200);

    await prisma.inTenant(tenant.id, (tx) =>
      tx.user.update({ where: { id: user.id }, data: { status: 'deactivated' } }),
    );

    await get('authenticated', accessToken).expect(401);
  });

  it("refuses a suspended tenant's token", async () => {
    const user = await createTestUser(prisma, suspended.id, { roles: ['owner'] });
    const { accessToken } = await tokens.issueForUser(suspended.id, user.id);

    await get('authenticated', accessToken).expect(403);
  });

  it('refuses a denied token', async () => {
    const user = await createTestUser(prisma, tenant.id);
    const issued = await tokens.issueForUser(tenant.id, user.id);
    await get('authenticated', issued.accessToken).expect(200);

    await tokens.deny(issued.jti, issued.expiresAt);

    await get('authenticated', issued.accessToken).expect(401);
  });

  it('applies a role change on the next request, without a new token', async () => {
    const user = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const { accessToken } = await tokens.issueForUser(tenant.id, user.id);
    await get('tenant-permission', accessToken).expect(200);

    await prisma.inTenant(tenant.id, async (tx) => {
      const member = await tx.role.findFirstOrThrow({ where: { name: 'member' } });
      await tx.userRole.deleteMany({ where: { userId: user.id } });
      await tx.userRole.create({ data: { userId: user.id, roleId: member.id } });
    });

    await get('tenant-permission', accessToken).expect(403);
  });
});
