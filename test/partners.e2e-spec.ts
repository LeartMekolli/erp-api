import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { partnerResponseSchema } from '../src/modules/partners/partner-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Partner {
  id: string;
  name: string;
  display_name: string;
  status: string;
  accepts_direct_orders: boolean;
  agreement: { file_version_id: string; signed_on: string } | null;
  member_count: number;
}

describe('partners: workshops managed by staff', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const as = (token: string) => ({
      post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    });
    return {
      id: tenant.id,
      ownerId: owner.id,
      owner: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken),
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const agreement = async (tenant: Tenant, status = 'uploaded') =>
    (await measuredDesign(prisma, tenant.id, tenant.ownerId, { status, measures: [] })).versionId;

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

  it('creates, lists, reads and edits partners, and audits changes', async () => {
    const tenant = await freshTenant();

    const created = await tenant.owner.post('/partners', { name: 'CastCo Ltd', display_name: 'CastCo' }).expect(201);
    expectDocumented(partnerResponseSchema, created.body);
    expect(created.body).toMatchObject({
      name: 'CastCo Ltd',
      display_name: 'CastCo',
      status: 'setting_up',
      accepts_direct_orders: false,
      agreement: null,
      member_count: 0,
    });
    const castco = (created.body as Partner).id;
    await tenant.owner.post('/partners', { name: 'MetalWorks', display_name: 'MetalWorks' }).expect(201);

    const listed = await tenant.owner.get('/partners').expect(200);
    expectDocumented(pageSchema(partnerResponseSchema), listed.body);
    expect((listed.body as { data: Partner[] }).data.map((partner) => partner.display_name)).toEqual(['MetalWorks', 'CastCo']);
    expect((await tenant.owner.get('/partners?status=approved').expect(200)).body).toMatchObject({ data: [] });

    const edited = await tenant.owner.patch(`/partners/${castco}`, { display_name: 'CastCo Foundry' }).expect(200);
    expect(edited.body).toMatchObject({ name: 'CastCo Ltd', display_name: 'CastCo Foundry' });
    expect((await tenant.owner.get(`/partners/${castco}`).expect(200)).body).toEqual(edited.body);

    const audited = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.count({ where: { action: 'partner.changed', subjectId: castco } }),
    );
    expect(audited).toBe(2);
  });

  it('approves a partner only once its signed agreement is on file, and can suspend it', async () => {
    const tenant = await freshTenant();
    const castco = ((await tenant.owner.post('/partners', { name: 'CastCo', display_name: 'CastCo' }).expect(201)).body as Partner).id;

    await tenant.owner.post(`/partners/${castco}/approve`).expect(409);

    // An agreement still being uploaded, or another workspace's, isn't there.
    await tenant.owner.put(`/partners/${castco}/agreement`, { file_version_id: await agreement(tenant, 'pending'), signed_on: '2026-10-20' }).expect(404);
    const other = await freshTenant();
    await tenant.owner.put(`/partners/${castco}/agreement`, { file_version_id: await agreement(other), signed_on: '2026-10-20' }).expect(404);
    await tenant.owner.put(`/partners/${castco}/agreement`, { file_version_id: newId(), signed_on: '2026-10-20' }).expect(404);
    await tenant.owner.put(`/partners/${castco}/agreement`, { file_version_id: await agreement(tenant), signed_on: '20 Oct' }).expect(400);

    const signed = await agreement(tenant);
    const withAgreement = await tenant.owner.put(`/partners/${castco}/agreement`, { file_version_id: signed, signed_on: '2026-10-20' }).expect(200);
    expect(withAgreement.body).toMatchObject({ status: 'setting_up', agreement: { file_version_id: signed, signed_on: '2026-10-20' } });

    expect((await tenant.owner.post(`/partners/${castco}/approve`).expect(200)).body).toMatchObject({ status: 'approved' });
    await tenant.owner.post(`/partners/${castco}/approve`).expect(409);
    expect((await tenant.owner.post(`/partners/${castco}/suspend`).expect(200)).body).toMatchObject({ status: 'suspended' });
    await tenant.owner.post(`/partners/${castco}/suspend`).expect(409);
    expect((await tenant.owner.post(`/partners/${castco}/approve`).expect(200)).body).toMatchObject({ status: 'approved' });
  });

  it('keeps partner setup to staff who may change it, and to the workspace', async () => {
    const tenant = await freshTenant();
    const castco = ((await tenant.owner.post('/partners', { name: 'CastCo', display_name: 'CastCo' }).expect(201)).body as Partner).id;

    await tenant.member.get('/partners').expect(200);
    await tenant.member.get(`/partners/${castco}`).expect(200);
    await tenant.member.post('/partners', { name: 'Nope', display_name: 'Nope' }).expect(403);
    await tenant.member.post(`/partners/${castco}/approve`).expect(403);

    await tenant.owner.post('/partners', { name: '', display_name: 'Blank' }).expect(400);
    await tenant.owner.post('/partners', { name: 'Blank' }).expect(400);
    await tenant.owner.get('/partners/not-a-uuid').expect(400);

    const other = await freshTenant();
    await other.owner.get(`/partners/${castco}`).expect(404);
    await other.owner.patch(`/partners/${castco}`, { name: 'Taken' }).expect(404);
    expect((await other.owner.get('/partners').expect(200)).body).toMatchObject({ data: [] });
  });
});
