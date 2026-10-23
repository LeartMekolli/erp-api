import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { pricingProfileResponseSchema, stepTypeResponseSchema } from '../src/modules/pricing/pricing-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

describe('pricing: step types and the pricing profile', () => {
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
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    });
    return {
      id: tenant.id,
      owner: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken),
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
    };
  }

  const casting = { key: 'casting', name: 'Casting', position: 30, summary_group: 'making' };

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

  it('creates, lists and edits step types', async () => {
    const tenant = await freshTenant();

    const created = await tenant.owner.post('/pricing/step-types', casting).expect(201);
    expectDocumented(stepTypeResponseSchema, created.body);
    expect(created.body).toMatchObject(casting);
    await tenant.owner.post('/pricing/step-types', { key: 'polishing', name: 'Polishing', position: 40, summary_group: 'finishing' }).expect(201);

    const listed = await tenant.owner.get('/pricing/step-types').expect(200);
    const data = (listed.body as { data: { key: string }[] }).data;
    expect(data.map((step) => step.key)).toEqual(['casting', 'polishing']);
    data.forEach((step) => expectDocumented(stepTypeResponseSchema, step));

    const { id } = created.body as { id: string };
    const edited = await tenant.owner.patch(`/pricing/step-types/${id}`, { name: 'Lost-wax casting', position: 35 }).expect(200);
    expect(edited.body).toMatchObject({ key: 'casting', name: 'Lost-wax casting', position: 35 });
  });

  it('keeps steps nobody prices, such as final QC, as not-priced step types', async () => {
    const tenant = await freshTenant();

    const priced = await tenant.owner.post('/pricing/step-types', casting).expect(201);
    expect(priced.body).toMatchObject({ key: 'casting', priced: true });

    const finalQc = await tenant.owner
      .post('/pricing/step-types', { key: 'final_qc', name: 'Final QC', position: 90, summary_group: null })
      .expect(201);
    expectDocumented(stepTypeResponseSchema, finalQc.body);
    expect(finalQc.body).toMatchObject({ key: 'final_qc', summary_group: null, priced: false });

    // A step type nothing uses yet can change between priced and not priced.
    const { id } = priced.body as { id: string };
    const unpriced = await tenant.owner.patch(`/pricing/step-types/${id}`, { summary_group: null }).expect(200);
    expect(unpriced.body).toMatchObject({ summary_group: null, priced: false });
    const repriced = await tenant.owner.patch(`/pricing/step-types/${id}`, { summary_group: 'making' }).expect(200);
    expect(repriced.body).toMatchObject({ summary_group: 'making', priced: true });
  });

  it('refuses bad step types', async () => {
    const tenant = await freshTenant();
    await tenant.owner.post('/pricing/step-types', casting).expect(201);

    await tenant.owner.post('/pricing/step-types', casting).expect(409);
    for (const body of [
      { ...casting, key: 'other', summary_group: 'other' },
      { ...casting, key: 'Casting Two' },
      { ...casting, key: 'other', position: -1 },
      { ...casting, key: 'other', position: 1.5 },
    ]) {
      const response = await tenant.owner.post('/pricing/step-types', body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
  });

  it('keeps the pricing profile, with defaults until it is set, and audits changes', async () => {
    const tenant = await freshTenant();

    const defaults = await tenant.owner.get('/pricing/profile').expect(200);
    expectDocumented(pricingProfileResponseSchema, defaults.body);
    expect(defaults.body).toEqual({ margin_percent: '0', overhead_per_piece: '0', quote_valid_days: 7 });

    const set = await tenant.owner
      .put('/pricing/profile', { margin_percent: '40', overhead_per_piece: '2', quote_valid_days: 3 })
      .expect(200);
    expectDocumented(pricingProfileResponseSchema, set.body);
    expect(set.body).toEqual({ margin_percent: '40', overhead_per_piece: '2', quote_valid_days: 3 });
    expect((await tenant.owner.get('/pricing/profile').expect(200)).body).toEqual(set.body);

    const entries = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'pricing.changed' }, orderBy: { id: 'asc' } }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      subjectType: 'pricing_profile',
      before: { margin_percent: '0', overhead_per_piece: '0', quote_valid_days: 7 },
      after: { margin_percent: '40', overhead_per_piece: '2', quote_valid_days: 3 },
    });

    for (const body of [
      { margin_percent: '40', overhead_per_piece: '2', quote_valid_days: 0 },
      { margin_percent: '1e2', overhead_per_piece: '2', quote_valid_days: 7 },
      { margin_percent: '1001', overhead_per_piece: '2', quote_valid_days: 7 },
      { margin_percent: '40', overhead_per_piece: '-1', quote_valid_days: 7 },
      { margin_percent: '40', overhead_per_piece: 'abc', quote_valid_days: 7 },
    ]) {
      const response = await tenant.owner.put('/pricing/profile', body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
  });

  it('keeps pricing to staff who may see it, and to the workspace', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const { id } = (await a.owner.post('/pricing/step-types', casting).expect(201)).body as { id: string };

    await a.member.get('/pricing/step-types').expect(403);
    await a.member.get('/pricing/profile').expect(403);
    await a.member.post('/pricing/step-types', { ...casting, key: 'other' }).expect(403);

    await b.owner.patch(`/pricing/step-types/${id}`, { name: 'Taken' }).expect(404);
    expect(((await b.owner.get('/pricing/step-types').expect(200)).body as { data: unknown[] }).data).toEqual([]);
  });
});
