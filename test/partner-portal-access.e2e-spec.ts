import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

/**
 * Who may act in the partner portal (Partners spec, goal 1; plan Review Focus 1): only partner
 * people, only for partners they belong to, and a suspended partner only reads.
 */
describe('partners: who may act in the partner portal', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  /** A partner person written straight to the database, with a membership in `partnerId`. */
  async function partnerPerson(tenantId: string, partnerId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind: 'partner' } });
      await tx.organisationMembership.create({
        data: { userId: user.id, organisationType: 'partner', organisationId: partnerId, role },
      });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const partner = async (name: string) =>
      ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
    return { id: tenant.id, staff, castco: await partner('CastCo'), metalworks: await partner('MetalWorks') };
  }

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

  it("never shows a partner person another partner's portal", async () => {
    const tenant = await freshTenant();
    const ana = await partnerPerson(tenant.id, tenant.castco, 'owner');

    await ana.get(`/partner-portal/partners/${tenant.castco}/members`).expect(200);
    await ana.get(`/partner-portal/partners/${tenant.metalworks}/members`).expect(404);
    await ana.post(`/partner-portal/partners/${tenant.metalworks}/invitations`, { email: `x-${newId()}@example.test`, role: 'member' }).expect(404);
    await ana.get(`/partner-portal/partners/${newId()}/members`).expect(404);
    await ana.get('/partner-portal/partners/not-a-uuid/members').expect(400);

    const other = await freshTenant();
    await ana.get(`/partner-portal/partners/${other.castco}/members`).expect(404);
  });

  it('keeps the partner portal to partner people', async () => {
    const tenant = await freshTenant();
    const customer = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, (tx) => tx.user.update({ where: { id: customer.id }, data: { kind: 'customer' } }));
    const asCustomer = as((await tokens.issueForUser(tenant.id, customer.id)).accessToken);

    await asCustomer.get(`/partner-portal/partners/${tenant.castco}/members`).expect(403);
    await asCustomer.get('/partner-portal/me').expect(403);
    await tenant.staff.get(`/partner-portal/partners/${tenant.castco}/members`).expect(403);
    await tenant.staff.get('/partner-portal/me').expect(403);
    await http().get(`/partner-portal/partners/${tenant.castco}/members`).expect(401);
  });

  it('lets a suspended partner read but not change anything', async () => {
    const tenant = await freshTenant();
    const ana = await partnerPerson(tenant.id, tenant.castco, 'owner');
    await prisma.inTenant(tenant.id, (tx) => tx.partner.update({ where: { id: tenant.castco }, data: { status: 'suspended' } }));

    await ana.get(`/partner-portal/partners/${tenant.castco}/members`).expect(200);
    await ana.post(`/partner-portal/partners/${tenant.castco}/invitations`, { email: `x-${newId()}@example.test`, role: 'member' }).expect(403);
  });
});
