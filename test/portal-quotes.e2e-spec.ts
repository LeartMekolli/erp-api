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
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { quoteResultResponseSchema, quoteSummaryResponseSchema } from '../src/modules/pricing/quote-response';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

const PASSWORD = 'a-long-customer-password';
const CONTACT_US = "We can't price this configuration yet. Please contact us.";

interface Summary {
  id: string;
  lines: { label: string; amount: string }[];
  unit_price: string;
}

type Client = ReturnType<typeof clientFor>;

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return {
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
  };
}

describe('portal: customers request their own quotes', () => {
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
   * The priced cast part, published. Luna (group trade): Anna owns it, Ben is a buyer. Sol: Sam owns it,
   * Ben is a viewer. Each customer has its own measured design; Sol also has a private published product,
   * and the catalog an unpublished one.
   */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const staffUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, staffUser.id)).accessToken);
    const setup = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: staffUser.id, runMetal });
    await staff.patch(`/catalog/products/${setup.productId}`, { published: true }).expect(200);

    const id = (response: request.Response) => (response.body as { id: string }).id;
    const luna = id(await staff.post('/customers', { name: 'Luna Jewels', customer_group_id: setup.tradeGroupId }).expect(201));
    const sol = id(await staff.post('/customers', { name: 'Sol Rings' }).expect(201));

    async function join(customerId: string, email: string, role: string, name?: string) {
      await staff.post(`/customers/${customerId}/invitations`, { email, role }).expect(201);
      const token = notifier.lastCustomerInvitationFor(email)!.token;
      await request(app.getHttpServer())
        .post('/auth/customer-invitations/accept')
        .send(name ? { token, name, password: PASSWORD } : { token })
        .expect(204);
    }
    const person = async (email: string) => {
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      return { id: user.id, client: clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken) };
    };
    const emails = { anna: `anna-${newId()}@portal.example.test`, ben: `ben-${newId()}@portal.example.test`, sam: `sam-${newId()}@portal.example.test` };
    await join(luna, emails.anna, 'owner', 'Anna');
    await join(luna, emails.ben, 'buyer', 'Ben');
    await join(sol, emails.sam, 'owner', 'Sam');
    await join(sol, emails.ben, 'viewer');
    const anna = await person(emails.anna);
    const ben = await person(emails.ben);
    const sam = await person(emails.sam);

    const lunaDesign = await measuredDesign(prisma, tenant.id, ben.id, { customerId: luna });
    const solDesign = await measuredDesign(prisma, tenant.id, sam.id, { customerId: sol });
    const product = async (body: object) =>
      id(
        await staff
          .post('/catalog/products', { category_id: setup.categoryId, kind: 'custom', sizing: { mode: 'range', min: '0.5', max: '2' }, ...body })
          .expect(201),
      );
    const solPrivate = await product({ key: 'sol_signet', name: 'Sol signet', published: true, customer_id: sol });
    const unpublished = await product({ key: 'internal_part', name: 'Internal part' });

    return {
      tenantId: tenant.id,
      staff,
      setup,
      luna,
      sol,
      anna: anna.client,
      ben: ben.client,
      sam: sam.client,
      lunaVersion: lunaDesign.versionId,
      solVersion: solDesign.versionId,
      solPrivate,
      unpublished,
    };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  const quotes = (customerId: string, rest = '') => `/portal/customers/${customerId}/quotes${rest}`;
  const silverPolished = (w: Workspace, extra: object = {}) => ({
    product_id: w.setup.productId,
    options: { material: 'silver_925', finish: 'polished' },
    size: { scale: '1.5' },
    file_version_id: w.lunaVersion,
    quantity: 1,
    ...extra,
  });
  const quoteCount = (tenantId: string) => prisma.inTenant(tenantId, (tx) => tx.quote.count());

  async function refused(client: Client, customerId: string, body: object) {
    const response = await client.post(quotes(customerId), body).expect(200);
    expectDocumented(quoteResultResponseSchema, response.body);
    return response;
  }

  it("quotes with the customer's own file and group, and shows the quote to everyone at the customer", async () => {
    const w = await workspace();

    const created = await w.ben.post(quotes(w.luna), silverPolished(w)).expect(201);
    expectDocumented(quoteResultResponseSchema, created.body);
    const quote = (created.body as { quote: Summary }).quote;
    // 165.0057675 less the trade group's 10 %.
    expect(quote.unit_price).toBe('148.51');
    expect(quote.lines.map((line) => line.label)).toEqual(['material', 'making', 'finishing', 'your_discount']);

    const listed = await w.anna.get(quotes(w.luna)).expect(200);
    expectDocumented(pageSchema(quoteSummaryResponseSchema), listed.body);
    expect((listed.body as { data: { id: string }[] }).data.map((row) => row.id)).toEqual([quote.id]);
    const read = await w.anna.get(quotes(w.luna, `/${quote.id}`)).expect(200);
    expectDocumented(quoteSummaryResponseSchema, read.body);
    expect(read.body).toMatchObject({ id: quote.id, unit_price: '148.51' });

    // Staff see whose quote it is, and the group it got.
    expect((await w.staff.get(`/pricing/quotes/${quote.id}`).expect(200)).body).toMatchObject({
      customer_id: w.luna,
      inputs: { customer_group: 'trade', file_version_id: w.lunaVersion },
    });

    // Sol's people see none of it.
    await w.sam.get(quotes(w.sol, `/${quote.id}`)).expect(404);
    await w.sam.get(quotes(w.luna, `/${quote.id}`)).expect(404);
    expect(((await w.sam.get(quotes(w.sol)).expect(200)).body as { data: unknown[] }).data).toEqual([]);
  });

  it("refuses another customer's file, an unpublished product and another customer's product, saving nothing", async () => {
    const w = await workspace();
    const staffDesign = w.setup.versionId;

    // Review focus 3.
    for (const extra of [
      { file_version_id: w.solVersion },
      { file_version_id: staffDesign },
      { product_id: w.unpublished },
      { product_id: w.solPrivate },
      { product_id: newId() },
    ]) {
      const response = await w.ben.post(quotes(w.luna), silverPolished(w, extra));
      expect({ extra, status: response.status }).toEqual({ extra, status: 404 });
    }
    expect(await quoteCount(w.tenantId)).toBe(0);
  });

  it('explains a refusal in plain words, and never shows the pricing setup', async () => {
    const w = await workspace();

    const combined = await refused(w.ben, w.luna, silverPolished(w, { options: { material: 'brass', finish: 'gold_plated' } }));
    expect(combined.body).toEqual({ accepted: false, reasons: [{ code: 'rule_requires', message: "These options can't be combined." }] });

    // A step of the product's own chain without a price.
    const engraving = (
      (await w.staff.post('/pricing/step-types', { key: 'engraving', name: 'Engraving', position: 60, summary_group: 'finishing' }).expect(201))
        .body as { id: string }
    ).id;
    await w.staff.put(`/pricing/products/${w.setup.productId}/steps`, { step_type_ids: [w.setup.steps.casting, engraving] }).expect(200);

    // The workflow has no engraving step yet: the same plain message, nothing about the workflow.
    const notInWorkflow = await refused(w.ben, w.luna, silverPolished(w));
    expect(notInWorkflow.body).toEqual({ accepted: false, reasons: [{ code: 'workflow_step_missing', message: CONTACT_US }] });
    await w.setup.workflow.setSteps([{ key: 'engraving', name: 'Engraving', step_type_id: engraving }]);

    const unpriced = await refused(w.ben, w.luna, silverPolished(w));
    expect(unpriced.body).toEqual({ accepted: false, reasons: [{ code: 'step_price_missing', message: CONTACT_US }] });

    // Review focus 4, on the raw body.
    for (const response of [combined, notInWorkflow, unpriced]) {
      expect(JSON.stringify(response.body)).not.toMatch(/casting|engraving|silver_925|gold_plated|rate|margin|minutes|rule_id|step"/);
    }
    expect(await quoteCount(w.tenantId)).toBe(0);
  });

  it("takes the customer's group, never one named in the request, and only from buyers", async () => {
    const w = await workspace();

    for (const extra of [{ customer_group: 'trade' }, { customer_id: w.sol }]) {
      const response = await w.ben.post(quotes(w.luna), silverPolished(w, extra));
      expect({ extra, status: response.status }).toEqual({ extra, status: 400 });
    }
    // Ben is only a viewer at Sol.
    await w.ben.post(quotes(w.sol), silverPolished(w, { file_version_id: w.solVersion })).expect(403);
    expect(await quoteCount(w.tenantId)).toBe(0);
  });

  it('lets staff quote for a customer, which the customer then sees', async () => {
    const w = await workspace();

    const created = await w.staff.post('/pricing/quotes', silverPolished(w, { customer_id: w.luna })).expect(201);
    const quote = (created.body as { quote: Summary }).quote;
    expect(quote.unit_price).toBe('148.51');

    expect(((await w.anna.get(quotes(w.luna)).expect(200)).body as { data: { id: string }[] }).data.map((row) => row.id)).toEqual([
      quote.id,
    ]);
    expect((await w.staff.get(`/pricing/quotes/${quote.id}`).expect(200)).body).toMatchObject({ customer_id: w.luna });
  });
});
