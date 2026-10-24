import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { transitionListItemSchema } from '../src/modules/workflow/work-order-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Row {
  id: string;
  kind: string;
  from_step: { key: string } | null;
  defect: { key: string } | null;
  actor: { id: string };
  work_order: { id: string; label: string };
  created_at: string;
}
interface Page {
  data: Row[];
  next_cursor: string | null;
}

describe('workflow: the QC history', () => {
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
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    });
    const ownerClient = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const setup = await pricedCastPart(ownerClient, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    return {
      id: tenant.id,
      ownerId: owner.id,
      memberId: member.id,
      setup,
      owner: ownerClient,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      customer: as((await tokens.issueForUser(tenant.id, customer.id)).accessToken),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** Starts `quantity` polished silver pieces of the given design; returns the group id and the piece ids. */
  async function started(tenant: Tenant, quantity: number, fileVersionId = tenant.setup.versionId) {
    const quoted = await tenant.owner
      .post('/pricing/quotes', {
        product_id: tenant.setup.productId,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        file_version_id: fileVersionId,
        quantity,
      })
      .expect(201);
    const quoteId = (quoted.body as { quote: { id: string } }).quote.id;
    const groupId = ((await tenant.owner.post('/workflow/groups', { quote_id: quoteId }).expect(201)).body as { id: string }).id;
    const listed = await tenant.owner.get(`/workflow/work-orders?group_id=${groupId}&limit=100`).expect(200);
    return { groupId, ids: (listed.body as { data: { id: string }[] }).data.map((piece) => piece.id) };
  }

  const pass = (client: Tenant['owner'], ids: string[], atStep: string) =>
    client.post('/workflow/moves', { work_order_ids: ids, at_step: atStep, kind: 'pass' }).expect(200);
  const history = async (tenant: Tenant, query: string): Promise<Page> =>
    (await tenant.owner.get(`/workflow/transitions?limit=200&${query}`).expect(200)).body as Page;

  /**
   * One tenant's QC history: 10 pieces of the first design passed to polishing, 3 of them failed there with
   * a scratch, and 2 pieces of a second design passed once by a member, after `between`.
   */
  async function workedTenant() {
    const tenant = await freshTenant();
    const first = await started(tenant, 10);
    for (const step of ['print_pattern', 'casting_tree', 'casting']) {
      await pass(tenant.owner, first.ids, step);
    }
    await tenant.owner
      .post('/workflow/moves', {
        work_order_ids: first.ids.slice(0, 3),
        at_step: 'polishing',
        kind: 'fail',
        defect_id: tenant.setup.workflow.defects.scratch,
        comment: 'Scratched in the drum',
      })
      .expect(200);

    // A pause either side, so the database clock and this one needn't agree to the millisecond.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const between = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const design = await measuredDesign(prisma, tenant.id, tenant.ownerId);
    const second = await started(tenant, 2, design.versionId);
    await pass(tenant.member, second.ids, 'print_pattern');
    return { tenant, first, second, between, designVersionId: design.versionId };
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

  it('lists every move newest first, each with its piece', async () => {
    const { tenant, first } = await workedTenant();

    const response = await tenant.owner.get('/workflow/transitions?limit=200').expect(200);
    expectDocumented(pageSchema(transitionListItemSchema), response.body);
    const { data, next_cursor } = response.body as Page;
    expect(data).toHaveLength(35);
    expect(next_cursor).toBeNull();
    expect(data.map((row) => row.created_at)).toEqual([...data.map((row) => row.created_at)].sort().reverse());

    const scratched = (await history(tenant, 'defect_key=scratch')).data;
    expect(scratched).toHaveLength(3);
    expect(scratched.every((row) => row.kind === 'fail' && row.from_step?.key === 'polishing')).toBe(true);
    expect(scratched.map((row) => row.work_order.id).sort()).toEqual(first.ids.slice(0, 3).sort());
    expect(scratched.map((row) => row.work_order.label).sort()).toEqual(['1/10', '2/10', '3/10']);
  });

  it('filters by piece, group, step, design file, actor and time', async () => {
    const { tenant, first, second, between, designVersionId } = await workedTenant();

    expect((await history(tenant, `work_order_id=${first.ids[0]}`)).data).toHaveLength(4);
    expect((await history(tenant, `group_id=${first.groupId}`)).data).toHaveLength(33);
    expect((await history(tenant, `group_id=${second.groupId}`)).data).toHaveLength(2);
    expect((await history(tenant, 'step_key=polishing')).data).toHaveLength(3);
    expect((await history(tenant, 'step_key=casting')).data).toHaveLength(10);
    expect((await history(tenant, `file_version_id=${designVersionId}`)).data).toHaveLength(2);
    expect((await history(tenant, `file_version_id=${tenant.setup.versionId}`)).data).toHaveLength(33);

    const byMember = (await history(tenant, `actor_user_id=${tenant.memberId}`)).data;
    expect(byMember).toHaveLength(2);
    expect(byMember.every((row) => row.actor.id === tenant.memberId)).toBe(true);

    expect((await history(tenant, `from=${encodeURIComponent(between)}`)).data).toHaveLength(2);
    expect((await history(tenant, `to=${encodeURIComponent(between)}`)).data).toHaveLength(33);
    expect((await history(tenant, `group_id=${first.groupId}&from=${encodeURIComponent(between)}`)).data).toHaveLength(0);
  });

  it('pages through the history without repeats', async () => {
    const { tenant } = await workedTenant();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = (await tenant.owner.get(`/workflow/transitions?limit=10${query}`).expect(200)).body as Page;
      seen.push(...page.data.map((row) => row.id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(35);
    expect(new Set(seen).size).toBe(35);
  });

  it("keeps the history to staff and to the workspace", async () => {
    const { tenant, first } = await workedTenant();
    const other = await freshTenant();

    expect((await history(other, '')).data).toEqual([]);
    expect((await history(other, `group_id=${first.groupId}`)).data).toEqual([]);
    expect((await tenant.member.get('/workflow/transitions').expect(200)).body).toMatchObject({ data: expect.any(Array) });
    await tenant.customer.get('/workflow/transitions').expect(403);

    await tenant.owner.get('/workflow/transitions?from=yesterday').expect(400);
    await tenant.owner.get('/workflow/transitions?defect_key=Not%20a%20key').expect(400);
    await tenant.owner.get('/workflow/transitions?group_id=not-a-uuid').expect(400);
    await tenant.owner.get('/workflow/transitions?limit=201').expect(400);
  });
});
