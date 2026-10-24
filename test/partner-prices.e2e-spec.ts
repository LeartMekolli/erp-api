import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { partnerPricesResponseSchema } from '../src/modules/partners/partner-response';
import { stepPriceResponseSchema } from '../src/modules/pricing/pricing-response';
import { QuotesService } from '../src/modules/pricing/quotes.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Price {
  id: string;
  step_type_id: string;
  material_id: string | null;
  failure_percent: string;
  blocks: { kind: string; amount?: string }[];
}

/**
 * Partner price lists (Partners spec, goal 8; B1): the same blocks as the workspace's step prices,
 * per partner, and a job costed for a partner with its prices on its own steps.
 */
describe('partners: price lists and what a job costs with a partner', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let quotes: QuotesService;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none, so silver is at its fallback.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

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

  /**
   * The priced cast part, a quote for 10 silver polished pieces, CastCo able to do the whole cast line
   * and MetalWorks everything but polishing.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });

    const partner = async (name: string) =>
      ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
    const castco = await partner('CastCo');
    const metalworks = await partner('MetalWorks');
    const capability = (step_type_id: string) => ({ step_type_id, capacity: 200, capacity_period: 'week' });
    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const finalQc = cast.workflow.notPriced.finalQc;
    await staff
      .put(`/partners/${castco}/capabilities`, { capabilities: [printPattern, castingTree, casting, polishing, finalQc].map(capability) })
      .expect(200);
    await staff
      .put(`/partners/${metalworks}/capabilities`, { capabilities: [printPattern, castingTree, casting, finalQc].map(capability) })
      .expect(200);

    const quoted = await staff
      .post('/pricing/quotes', {
        product_id: cast.productId,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        file_version_id: cast.versionId,
        quantity: 10,
      })
      .expect(201);
    const quoteId = (quoted.body as { quote: { id: string } }).quote.id;

    return {
      id: tenant.id,
      staff,
      cast,
      castco,
      metalworks,
      quoteId,
      castcoOwner: await partnerPerson(tenant.id, castco, 'owner'),
      castcoMember: await partnerPerson(tenant.id, castco, 'member'),
    };
  }

  const costFor = (tenantId: string, quoteId: string, partnerId: string) =>
    prisma.inTenant(tenantId, (tx) => quotes.costFor(tx, quoteId, partnerId));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    quotes = moduleRef.get(QuotesService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it("starts a partner's prices from the workspace's, which it then changes for itself", async () => {
    const tenant = await freshTenant();
    const portal = `/partner-portal/partners/${tenant.castco}`;
    const { printPattern, castingTree, casting, polishing } = tenant.cast.steps;

    const none = await tenant.castcoMember.get(`${portal}/prices`).expect(200);
    expectDocumented(partnerPricesResponseSchema, none.body);
    expect(none.body).toEqual({ data: [] });

    // Every priced step type of its capabilities; final QC is a capability nobody prices.
    const copied = await tenant.castcoOwner.post(`${portal}/prices/copy-from-workspace`).expect(200);
    expectDocumented(partnerPricesResponseSchema, copied.body);
    const prices = (copied.body as { data: Price[] }).data;
    expect(prices.map((price) => price.step_type_id)).toEqual([printPattern, castingTree, casting, polishing]);
    const workspaceCasting = (await tenant.staff.get(`/pricing/step-types/${casting}/prices`).expect(200)).body as { data: Price[] };
    expect(prices[2]).toMatchObject({
      material_id: null,
      failure_percent: workspaceCasting.data[0].failure_percent,
      blocks: workspaceCasting.data[0].blocks,
    });

    // CastCo's casting setup is 30, not the workspace's 15; the workspace's own price is unchanged.
    const castingBlocks = [
      { kind: 'material', source: { configuration: true }, basis: 'weight', loss_percent: '5' },
      { kind: 'setup', amount: '30' },
    ];
    const raised = await tenant.castcoOwner
      .put(`${portal}/step-types/${casting}/prices`, { failure_percent: '0', blocks: castingBlocks })
      .expect(200);
    expectDocumented(stepPriceResponseSchema, raised.body);
    expect((raised.body as Price).id).toBe(prices[2].id);
    expect(((await tenant.staff.get(`/pricing/step-types/${casting}/prices`).expect(200)).body as { data: Price[] }).data[0].blocks).toEqual(
      workspaceCasting.data[0].blocks,
    );

    // Staff see CastCo's list; copying again adds nothing it already prices.
    const listed = await tenant.staff.get(`/partners/${tenant.castco}/prices`).expect(200);
    expectDocumented(partnerPricesResponseSchema, listed.body);
    expect((listed.body as { data: Price[] }).data.find((price) => price.step_type_id === casting)?.blocks).toContainEqual({
      kind: 'setup',
      amount: '30',
    });
    const again = await tenant.staff.post(`/partners/${tenant.castco}/prices/copy-from-workspace`).expect(200);
    expect(again.body).toEqual(listed.body);
  });

  it('refuses prices that do not fit, and keeps them to the partner and its admins', async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const portal = `/partner-portal/partners/${tenant.castco}`;
    const { casting } = tenant.cast.steps;
    const setup = { failure_percent: '0', blocks: [{ kind: 'setup', amount: '10' }] };

    // Nobody prices final QC.
    await tenant.castcoOwner.put(`${portal}/step-types/${tenant.cast.workflow.notPriced.finalQc}/prices`, setup).expect(400);
    // A material that isn't there, a step type that isn't, or another workspace's.
    const unknownMaterial = { failure_percent: '0', blocks: [{ kind: 'material', source: { material_id: newId() }, basis: 'weight', loss_percent: '0' }] };
    await tenant.castcoOwner.put(`${portal}/step-types/${casting}/prices`, unknownMaterial).expect(404);
    await tenant.castcoOwner.put(`${portal}/step-types/${casting}/prices`, { ...setup, material_id: other.cast.silver }).expect(404);
    await tenant.castcoOwner.put(`${portal}/step-types/${newId()}/prices`, setup).expect(404);
    await tenant.castcoOwner.put(`${portal}/step-types/${other.cast.steps.casting}/prices`, setup).expect(404);
    await tenant.castcoOwner.put(`${portal}/step-types/${casting}/prices`, { failure_percent: '101', blocks: [] }).expect(400);

    // Members work jobs; another partner's list, or another workspace's partner, isn't there.
    await tenant.castcoMember.put(`${portal}/step-types/${casting}/prices`, setup).expect(403);
    await tenant.castcoMember.post(`${portal}/prices/copy-from-workspace`).expect(403);
    await tenant.castcoOwner.get(`/partner-portal/partners/${tenant.metalworks}/prices`).expect(404);
    await tenant.staff.get(`/partners/${other.castco}/prices`).expect(404);

    // A material's own price sits next to the step's default.
    const silver = await tenant.staff
      .put(`/partners/${tenant.castco}/step-types/${casting}/prices`, { ...setup, material_id: tenant.cast.silver })
      .expect(200);
    expect(silver.body).toMatchObject({ material_id: tenant.cast.silver });
    expect(((await tenant.staff.get(`/partners/${tenant.castco}/prices`).expect(200)).body as { data: Price[] }).data).toHaveLength(1);
  });

  it("costs a job with a partner's prices on the partner's steps", async () => {
    const tenant = await freshTenant();
    await tenant.staff.post(`/partners/${tenant.castco}/prices/copy-from-workspace`).expect(200);

    // With the workspace's own prices, CastCo's cost is the quote's step costs for the 10 pieces.
    const quote = (await tenant.staff.get(`/pricing/quotes/${tenant.quoteId}`).expect(200)).body as {
      breakdown: { steps: { key: string; cost: string }[] };
    };
    expect(quote.breakdown.steps.map((step) => step.key)).toEqual(['print_pattern', 'casting_tree', 'casting', 'polishing']);
    const workspaceCost = quote.breakdown.steps
      .reduce((sum, step) => sum.plus(step.cost), new Prisma.Decimal(0))
      .times(10)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const same = await costFor(tenant.id, tenant.quoteId, tenant.castco);
    expect(same.refusals).toEqual([]);
    expect(same.cost?.toFixed(2)).toBe(workspaceCost.toFixed(2));

    // Casting's setup at 30 instead of 15: the job of 10 costs exactly 15 more with CastCo.
    await tenant.staff
      .put(`/partners/${tenant.castco}/step-types/${tenant.cast.steps.casting}/prices`, {
        failure_percent: '0',
        blocks: [
          { kind: 'material', source: { configuration: true }, basis: 'weight', loss_percent: '5' },
          { kind: 'setup', amount: '30' },
        ],
      })
      .expect(200);
    const raised = await costFor(tenant.id, tenant.quoteId, tenant.castco);
    expect(raised.cost?.minus(workspaceCost).toFixed(2)).toBe('15.00');

    // A step the workspace does in-house isn't the partner's cost, whatever the partner charges for it.
    const steps = tenant.cast.workflow;
    await tenant.staff
      .put(`/workflow/workflows/${steps.workflowId}/steps`, {
        steps: ((await tenant.staff.get(`/workflow/workflows/${steps.workflowId}`).expect(200)).body as {
          current_version: { steps: { key: string; step_type: { id: string }; name: string }[] };
        }).current_version.steps.map((step) => ({
          key: step.key,
          name: step.name,
          step_type_id: step.step_type.id,
          done_by: step.key === 'polishing' ? 'workspace' : 'partner',
        })),
      })
      .expect(200);
    const withoutPolishing = await costFor(tenant.id, tenant.quoteId, tenant.castco);
    const partnerSteps = quote.breakdown.steps
      .filter((step) => step.key !== 'polishing')
      .reduce((sum, step) => sum.plus(step.cost), new Prisma.Decimal(0))
      .times(10)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    expect(withoutPolishing.cost?.toFixed(2)).toBe(partnerSteps.plus(15).toFixed(2));
  });

  it("refuses a job a partner hasn't priced every step of", async () => {
    const tenant = await freshTenant();
    // MetalWorks can't polish, so copying gives it no polishing price.
    await tenant.staff.post(`/partners/${tenant.metalworks}/prices/copy-from-workspace`).expect(200);

    const result = await costFor(tenant.id, tenant.quoteId, tenant.metalworks);
    expect(result.cost).toBeNull();
    expect(result.refusals).toEqual([expect.objectContaining({ code: 'step_price_missing', step: 'polishing' })]);
  });
});
