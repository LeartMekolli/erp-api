import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import {
  groupResponseSchema,
  workOrderDetailResponseSchema,
  workOrderResponseSchema,
} from '../src/modules/workflow/work-order-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import type { PricedCastPart } from './pricing-fixtures';

interface Group {
  id: string;
  quantity: number;
  workflow: { id: string; name: string; version: number };
  source: { type: string; id: string };
  pieces: { active: number; finished: number; scrapped: number };
  steps: { key: string; count: number }[];
}
interface WorkOrder {
  id: string;
  group_id: string;
  number: number;
  label: string;
  status: string;
  step: { key: string } | null;
}

describe('workflow: starting work orders from a quote', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

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
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    });
    const ownerClient = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const setup = await pricedCastPart(ownerClient, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    return {
      id: tenant.id,
      setup,
      owner: ownerClient,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      customer: as((await tokens.issueForUser(tenant.id, customer.id)).accessToken),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const castPart = (setup: PricedCastPart, finish: string, quantity: number) => ({
    product_id: setup.productId,
    options: { material: 'silver_925', finish },
    size: { scale: '1.5' },
    file_version_id: setup.versionId,
    quantity,
  });

  async function quote(tenant: Tenant, finish = 'polished', quantity = 10): Promise<string> {
    const response = await tenant.owner.post('/pricing/quotes', castPart(tenant.setup, finish, quantity)).expect(201);
    return (response.body as { quote: { id: string } }).quote.id;
  }

  const pieces = async (tenant: Tenant, query: string) =>
    ((await tenant.owner.get(`/workflow/work-orders?${query}`).expect(200)).body as { data: WorkOrder[] }).data;

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

  it('starts one work order per piece at the first step, on the path the quote priced', async () => {
    const tenant = await freshTenant();
    const quoteId = await quote(tenant);

    const started = await tenant.member.post('/workflow/groups', { quote_id: quoteId }).expect(201);
    expectDocumented(groupResponseSchema, started.body);
    const group = started.body as Group;
    expect(group).toMatchObject({
      quantity: 10,
      workflow: { id: tenant.setup.workflow.workflowId, name: 'Cast rings', version: 1 },
      source: { type: 'quote', id: quoteId },
      pieces: { active: 10, finished: 0, scrapped: 0 },
    });
    // Polished silver isn't plated, so plating is not on its path; final QC and packing always are.
    expect(group.steps).toEqual([
      { key: 'print_pattern', name: 'Print pattern', count: 10 },
      { key: 'casting_tree', name: 'Casting tree', count: 0 },
      { key: 'casting', name: 'Casting', count: 0 },
      { key: 'polishing', name: 'Polishing', count: 0 },
      { key: 'final_qc', name: 'Final QC', count: 0 },
      { key: 'packing', name: 'Packing', count: 0 },
    ]);

    const listed = await tenant.owner.get(`/workflow/work-orders?group_id=${group.id}&limit=20`).expect(200);
    expectDocumented(pageSchema(workOrderResponseSchema), listed.body);
    const data = (listed.body as { data: WorkOrder[] }).data;
    expect(data.map((piece) => piece.label)).toEqual(Array.from({ length: 10 }, (_, index) => `${index + 1}/10`));
    expect(data.every((piece) => piece.status === 'active' && piece.step?.key === 'print_pattern')).toBe(true);

    const one = await tenant.owner.get(`/workflow/work-orders/${data[2].id}`).expect(200);
    expectDocumented(workOrderDetailResponseSchema, one.body);
    expect(one.body).toMatchObject({
      label: '3/10',
      group_id: group.id,
      step: { key: 'print_pattern' },
      replaces_id: null,
      sop_file_version_id: null,
      path: ['print_pattern', 'casting_tree', 'casting', 'polishing', 'final_qc', 'packing'].map((key) => ({ key })),
    });

    expect((await tenant.owner.get(`/workflow/groups/${group.id}`).expect(200)).body).toEqual(group);
    expect(await pieces(tenant, 'step_key=print_pattern&limit=50')).toHaveLength(10);
    expect(await pieces(tenant, 'step_key=casting')).toHaveLength(0);
  });

  it('puts plating on the path of a gold-plated order', async () => {
    const tenant = await freshTenant();
    const started = await tenant.owner.post('/workflow/groups', { quote_id: await quote(tenant, 'gold_plated', 2) }).expect(201);
    expect((started.body as Group).steps.map((step) => step.key)).toEqual([
      'print_pattern',
      'casting_tree',
      'casting',
      'polishing',
      'plating',
      'final_qc',
      'packing',
    ]);
  });

  it('starts a quote once, and only while it holds', async () => {
    const tenant = await freshTenant();
    const quoteId = await quote(tenant);
    await tenant.owner.post('/workflow/groups', { quote_id: quoteId }).expect(201);
    await tenant.owner.post('/workflow/groups', { quote_id: quoteId }).expect(409);

    const expired = await quote(tenant);
    await prisma.inTenant(tenant.id, (tx) =>
      tx.quote.update({ where: { id: expired }, data: { expiresAt: new Date(Date.now() - 60_000) } }),
    );
    await tenant.owner.post('/workflow/groups', { quote_id: expired }).expect(409);

    const tooMany = await quote(tenant, 'polished', 10_001);
    await tenant.owner.post('/workflow/groups', { quote_id: tooMany }).expect(400);

    const other = await freshTenant();
    await other.owner.post('/workflow/groups', { quote_id: quoteId }).expect(404);
    await tenant.owner.post('/workflow/groups', { quote_id: newId() }).expect(404);
    await tenant.owner.post('/workflow/groups', { quote_id: 'not-a-uuid' }).expect(400);
  });

  it('refuses to start when the workflow has lost a step the quote priced', async () => {
    const tenant = await freshTenant();
    const quoteId = await quote(tenant);
    const { setup } = tenant;
    const short = (
      (await tenant.owner.post('/workflow/workflows', { key: 'short', name: 'Short' }).expect(201)).body as { id: string }
    ).id;
    await tenant.owner
      .put(`/workflow/workflows/${short}/steps`, {
        steps: [
          { key: 'print_pattern', name: 'Print pattern', step_type_id: setup.steps.printPattern },
          { key: 'casting_tree', name: 'Casting tree', step_type_id: setup.steps.castingTree },
          { key: 'casting', name: 'Casting', step_type_id: setup.steps.casting },
        ],
      })
      .expect(200);
    await tenant.owner.put(`/workflow/products/${setup.productId}/workflow`, { workflow_id: short }).expect(200);

    const refused = await tenant.owner.post('/workflow/groups', { quote_id: quoteId }).expect(409);
    expect(JSON.stringify(refused.body)).toContain('polishing');
    expect(await prisma.inTenant(tenant.id, (tx) => tx.workOrder.count())).toBe(0);
  });

  it('keeps work orders to staff and to the workspace', async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const group = (await tenant.owner.post('/workflow/groups', { quote_id: await quote(tenant) }).expect(201)).body as Group;
    const [piece] = await pieces(tenant, `group_id=${group.id}`);

    await tenant.customer.post('/workflow/groups', { quote_id: await quote(tenant) }).expect(403);
    await tenant.customer.get(`/workflow/groups/${group.id}`).expect(403);
    await tenant.customer.get('/workflow/work-orders').expect(403);

    await other.owner.get(`/workflow/groups/${group.id}`).expect(404);
    await other.owner.get(`/workflow/work-orders/${piece.id}`).expect(404);
    expect(await pieces(other, '')).toEqual([]);
  });
});
