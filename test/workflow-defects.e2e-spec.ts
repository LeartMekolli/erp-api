import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { defectResponseSchema } from '../src/modules/workflow/workflow-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Defect {
  id: string;
  key: string;
  name: string;
  active: boolean;
}

describe('workflow: the defect catalogue', () => {
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
    const customer = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, (tx) => tx.user.update({ where: { id: customer.id }, data: { kind: 'customer' } }));
    const as = (token: string) => ({
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    });
    return {
      id: tenant.id,
      owner: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken),
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      customer: as((await tokens.issueForUser(tenant.id, customer.id)).accessToken),
    };
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

  it('creates, lists and deactivates defects, auditing changes', async () => {
    const tenant = await freshTenant();

    const created = await tenant.owner.post('/workflow/defects', { key: 'porosity', name: 'Porosity' }).expect(201);
    expectDocumented(defectResponseSchema, created.body);
    expect(created.body).toMatchObject({ key: 'porosity', name: 'Porosity', active: true });
    await tenant.owner.post('/workflow/defects', { key: 'crack', name: 'Crack' }).expect(201);

    const listed = await tenant.member.get('/workflow/defects').expect(200);
    const data = (listed.body as { data: Defect[] }).data;
    expect(data.map((defect) => defect.key)).toEqual(['crack', 'porosity']);
    data.forEach((defect) => expectDocumented(defectResponseSchema, defect));

    const { id } = created.body as Defect;
    const edited = await tenant.owner.patch(`/workflow/defects/${id}`, { name: 'Gas porosity', active: false }).expect(200);
    expectDocumented(defectResponseSchema, edited.body);
    expect(edited.body).toMatchObject({ key: 'porosity', name: 'Gas porosity', active: false });
    const after = (await tenant.owner.get('/workflow/defects').expect(200)).body as { data: Defect[] };
    expect(after.data.find((defect) => defect.id === id)).toMatchObject({ active: false });

    const entries = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'workflow.changed', subjectType: 'defect' } }),
    );
    expect(entries).toHaveLength(3);
  });

  it('refuses duplicate and malformed defects', async () => {
    const tenant = await freshTenant();
    await tenant.owner.post('/workflow/defects', { key: 'porosity', name: 'Porosity' }).expect(201);

    await tenant.owner.post('/workflow/defects', { key: 'porosity', name: 'Again' }).expect(409);
    for (const body of [{ key: 'Porosity Two', name: 'x' }, { key: 'scratch', name: '' }, { key: 'scratch' }]) {
      const response = await tenant.owner.post('/workflow/defects', body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
  });

  it('keeps defects to staff who may see them, and to the workspace', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const { id } = (await a.owner.post('/workflow/defects', { key: 'porosity', name: 'Porosity' }).expect(201)).body as Defect;

    await a.member.post('/workflow/defects', { key: 'scratch', name: 'Scratch' }).expect(403);
    await a.member.patch(`/workflow/defects/${id}`, { active: false }).expect(403);
    await a.customer.get('/workflow/defects').expect(403);

    await b.owner.patch(`/workflow/defects/${id}`, { name: 'Taken' }).expect(404);
    expect(((await b.owner.get('/workflow/defects').expect(200)).body as { data: unknown[] }).data).toEqual([]);
  });
});
