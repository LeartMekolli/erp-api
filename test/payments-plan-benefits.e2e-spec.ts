import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { customerResponseSchema } from '../src/modules/customers/customer-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { quoteResponseSchema } from '../src/modules/pricing/quote-response';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

const PASSWORD = 'a-long-customer-password';

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return {
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
  };
}

interface Adjustment {
  kind: string;
  percent: string;
  amount: string;
}

/** What a plan changes: the discount, the speeds, the members and pay later (Payments 2 plan, Task 2). */
describe('payments: what a plan changes', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_NOTIFIER)
      .useValue(notifier)
      .compile();
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

  /**
   * The priced cast part, published, with speeds standard (default), rush (30 %) and express (25 %).
   * Luna is in the trade group (−10 %) and Anna owns it; every customer is on Starter.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const staffUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, staffUser.id)).accessToken);
    const setup = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: staffUser.id, runMetal });
    await staff.patch(`/catalog/products/${setup.productId}`, { published: true }).expect(200);
    await staff.post('/pricing/delivery-speeds', { key: 'express', name: 'Express', surcharge_percent: '25' }).expect(201);

    const luna = (await staff.post('/customers', { name: 'Luna Jewels', customer_group_id: setup.tradeGroupId }).expect(201)).body as {
      id: string;
    };
    const annaEmail = `anna-${newId()}@plans.example.test`;
    await staff.post(`/customers/${luna.id}/invitations`, { email: annaEmail, role: 'owner' }).expect(201);
    await request(app.getHttpServer())
      .post('/auth/customer-invitations/accept')
      .send({ token: notifier.lastCustomerInvitationFor(annaEmail)!.token, name: 'Anna', password: PASSWORD })
      .expect(204);
    const annaUser = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email: annaEmail } }));
    const anna = clientFor(app, (await tokens.issueForUser(tenant.id, annaUser.id)).accessToken);

    // A customer quotes only with its own files.
    const lunaVersion = (await measuredDesign(prisma, tenant.id, annaUser.id, { customerId: luna.id })).versionId;

    const plans = (await staff.get('/payments/plans').expect(200)).body as { data: { id: string; is_default: boolean }[] };
    const starter = plans.data.find((plan) => plan.is_default)!.id;
    return { tenantId: tenant.id, staff, anna, setup, luna: luna.id, lunaVersion, starter };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const cube = (w: Workspace, extra: object = {}) => ({
    product_id: w.setup.productId,
    options: { material: 'brass', finish: 'raw' },
    size: { scale: '1' },
    file_version_id: w.setup.versionId,
    quantity: 1,
    ...extra,
  });
  /** The same configuration from the portal, on the customer's own design. */
  const portalCube = (w: Workspace, extra: object = {}) => cube(w, { file_version_id: w.lunaVersion, ...extra });
  const adjustments = (body: unknown) =>
    ((body as { breakdown: { adjustments: Adjustment[] } }).breakdown.adjustments).map((line) => [line.kind, line.percent]);
  /** A staff quote, read back in the staff view, which has the breakdown. */
  async function staffQuote(w: Workspace, body: object): Promise<unknown> {
    const created = await w.staff.post('/pricing/quotes', body).expect(201);
    const id = (created.body as { quote: { id: string } }).quote.id;
    const view = await w.staff.get(`/pricing/quotes/${id}`).expect(200);
    expectDocumented(quoteResponseSchema, view.body);
    return view.body;
  }

  it("offers a Starter customer only the workspace's default speed, with no plan line", async () => {
    const w = await workspace();

    const refused = await w.anna.post(`/portal/customers/${w.luna}/quotes`, portalCube(w, { delivery_speed: 'rush' })).expect(400);
    expect(JSON.stringify(refused.body)).toContain("rush is not offered on the customer's plan (Starter)");

    const plain = await staffQuote(w, { ...cube(w), customer_id: w.luna });
    expect(adjustments(plain)).toEqual([
      ['customer_group', '-10'],
      ['delivery_speed', '0'],
    ]);
    expect((plain as { inputs: { plan: string | null } }).inputs.plan).toBe('starter');
    const portal = await w.anna.post(`/portal/customers/${w.luna}/quotes`, portalCube(w)).expect(201);
    const labels = (portal.body as { quote: { lines: { label: string }[] } }).quote.lines.map((line) => line.label);
    expect(labels).not.toContain('plan_discount');
  });

  it("applies the plan's discount after the group and its own speed surcharge, for staff and the customer", async () => {
    const w = await workspace();
    await w.staff
      .patch(`/payments/plans/${w.starter}`, { discount_percent: '5', speeds: [{ key: 'express', surcharge_percent: '15' }] })
      .expect(200);

    const quote = await staffQuote(w, { ...cube(w), customer_id: w.luna, delivery_speed: 'express' });
    expect(adjustments(quote)).toEqual([
      ['customer_group', '-10'],
      ['plan', '5'],
      ['delivery_speed', '15'],
    ]);

    const portal = await w.anna.post(`/portal/customers/${w.luna}/quotes`, portalCube(w, { delivery_speed: 'express' })).expect(201);
    const labels = (portal.body as { quote: { lines: { label: string }[] } }).quote.lines.map((line) => line.label);
    expect(labels).toEqual(expect.arrayContaining(['your_discount', 'plan_discount', 'delivery_speed']));

    // Rush is still not on the plan.
    await w.anna.post(`/portal/customers/${w.luna}/quotes`, portalCube(w, { delivery_speed: 'rush' })).expect(400);
  });

  it('refuses a staff quote for a customer a speed its plan lacks, but not a quote for no customer', async () => {
    const w = await workspace();

    const refused = await w.staff.post('/pricing/quotes', { ...cube(w), customer_id: w.luna, delivery_speed: 'rush' }).expect(400);
    expect(JSON.stringify(refused.body)).toContain('Starter');

    const internal = await staffQuote(w, { ...cube(w), delivery_speed: 'rush' });
    expect(adjustments(internal)).toEqual([['delivery_speed', '30']]);
    expect((internal as { inputs: { plan: string | null } }).inputs.plan).toBeNull();
  });

  it("stops invitations at the plan's member limit, counting open invitations", async () => {
    const w = await workspace();
    const invite = (email: string) => w.staff.post(`/customers/${w.luna}/invitations`, { email, role: 'buyer' });
    // A new workspace's free plan has no limit until staff set one.
    await w.staff.patch(`/payments/plans/${w.starter}`, { member_limit: 2 }).expect(200);

    // Anna is one member; one open invitation makes two, Starter's limit.
    await invite(`ben-${newId()}@plans.example.test`).expect(201);
    const refused = await invite(`cleo-${newId()}@plans.example.test`).expect(409);
    expect(JSON.stringify(refused.body)).toContain("The customer's plan (Starter) allows 2 members");
    await w.anna.post(`/portal/customers/${w.luna}/invitations`, { email: `dan-${newId()}@plans.example.test`, role: 'buyer' }).expect(409);

    // An edit reaches every customer on the plan at once.
    await w.staff.patch(`/payments/plans/${w.starter}`, { member_limit: 3 }).expect(200);
    await invite(`cleo-${newId()}@plans.example.test`).expect(201);
    await w.staff.patch(`/payments/plans/${w.starter}`, { member_limit: null }).expect(200);
    await invite(`eve-${newId()}@plans.example.test`).expect(201);
  });

  it('allows pay later only on a plan with it, and never changes terms already set', async () => {
    const w = await workspace();
    const terms = { terms: 'pay_later', days_to_pay: 30, credit_limit: '5000.00' };
    // A new workspace's free plan allows pay later until staff turn it off.
    await w.staff.patch(`/payments/plans/${w.starter}`, { features: [] }).expect(200);

    const refused = await w.staff.put(`/customers/${w.luna}/payment-terms`, terms).expect(409);
    expect(JSON.stringify(refused.body)).toContain("The customer's plan (Starter) doesn't allow pay later");
    await w.staff.put(`/customers/${w.luna}/payment-terms`, { ...terms, terms: 'pay_first' }).expect(200);

    await w.staff.patch(`/payments/plans/${w.starter}`, { features: ['pay_later'] }).expect(200);
    await w.staff.put(`/customers/${w.luna}/payment-terms`, terms).expect(200);

    await w.staff.patch(`/payments/plans/${w.starter}`, { features: [] }).expect(200);
    const customer = await w.staff.get(`/customers/${w.luna}`).expect(200);
    expect((customer.body as { payment_terms: { terms: string } }).payment_terms.terms).toBe('pay_later');
  });

  it("shows staff the customer's plan", async () => {
    const w = await workspace();

    const customer = await w.staff.get(`/customers/${w.luna}`).expect(200);

    expectDocumented(customerResponseSchema, customer.body);
    expect((customer.body as { plan: unknown }).plan).toEqual({ key: 'starter', name: 'Starter' });
  });
});
