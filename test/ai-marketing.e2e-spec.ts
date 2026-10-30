import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AI_PROVIDER } from '../src/modules/ai/ai-provider';
import { customerResultSchema, startedSchema } from '../src/modules/ai/customer-tools/customer-result-response';
import { fakeToolUse } from '../src/modules/ai/fake-ai-provider';
import type { FakeAiProvider } from '../src/modules/ai/fake-ai-provider';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

const PASSWORD = 'a-long-customer-password';
const DAY_MS = 86_400_000;
const SETUP_MS = 90_000;

const fixture: JobRegistry = { jobs: { ...JOBS, 'ai.run': { ...JOBS['ai.run'], backoffMs: 10 } }, scheduled: SCHEDULED_JOBS };

interface Figure {
  key: string;
  label: string;
  value: string;
}
interface Result {
  status: string;
  credits: number;
  output: { cards: { title: string; advice: string; figures: Figure[] }[] } | null;
}

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return {
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
  };
}
type Client = ReturnType<typeof clientFor>;

/** Marketing advice from the customer's own numbers, and no one else's (AI 2 plan, Task 4). */
describe('ai: marketing insights', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakeAiProvider;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  let tenantId: string;
  let luna: string;
  let sol: string;
  let anna: Client;
  let vic: Client;
  let lunaSpend: string;
  let solOrderNumber: number;

  /**
   * A workspace with a 5.00 USD AI limit and marketing on the default plan. Luna (Anna owner, Vic viewer)
   * has two orders this quarter, one cancelled, and one 120 days ago; Sol Rings has one order of its own.
   */
  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JOB_REGISTRY)
      .useValue(fixture)
      .overrideProvider(IDENTITY_NOTIFIER)
      .useValue(notifier)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
    // The run executes in the worker, so the worker's fake answers.
    fake = worker.get<FakeAiProvider>(AI_PROVIDER);

    const tenant = await createTestTenant(prisma);
    tenantId = tenant.id;
    createdTenants.push(tenant.id);
    await prisma.inTenant(tenant.id, (tx) =>
      tx.tenant.update({ where: { id: tenant.id }, data: { aiMonthlyLimitUsd: new Prisma.Decimal('5.00') } }),
    );
    const staffUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, staffUser.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: staffUser.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const speeds = (await staff.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] };
    await staff.patch(`/pricing/delivery-speeds/${speeds.data.find((speed) => speed.key === 'standard')!.id}`, { working_days: 10 }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '0' }] }).expect(200);

    const plans = (await staff.get('/payments/plans').expect(200)).body as { data: { id: string; is_default: boolean; features: string[] }[] };
    const starter = plans.data.find((plan) => plan.is_default)!;
    await staff.patch(`/payments/plans/${starter.id}`, { features: [...starter.features, 'ai_marketing'] }).expect(200);

    const expiresOn = new Date(Date.now() + 30 * DAY_MS).toISOString().slice(0, 10);
    const customer = async (name: string) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      await staff.put(`/customers/${id}/payment-terms`, { terms: 'pay_later' }).expect(200);
      await staff.post(`/payments/customers/${id}/credits`, { amount: 20, expires_on: expiresOn, reason: 'AI trial' }).expect(201);
      return id;
    };
    const order = async (customerId: string, name: string, quantity: number, daysAgo = 0) => {
      const quote = (
        (
          await staff
            .post('/pricing/quotes', {
              product_id: cast.productId,
              options: { material: 'silver_925', finish: 'polished' },
              size: { scale: '1.5' },
              quantity,
              file_version_id: cast.versionId,
              customer_id: customerId,
            })
            .expect(201)
        ).body as { quote: { id: string } }
      ).quote;
      const placed = (
        await staff
          .post('/orders', {
            customer_id: customerId,
            lines: [{ quote_id: quote.id }],
            address: { name, line1: 'Main street 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
            shipping_method: 'courier',
          })
          .expect(201)
      ).body as { id: string; number: number };
      if (daysAgo > 0) {
        await prisma.inTenant(tenant.id, (tx) =>
          tx.order.update({ where: { id: placed.id }, data: { placedAt: new Date(Date.now() - daysAgo * DAY_MS) } }),
        );
      }
      return placed;
    };
    const person = async (customerId: string, name: string, role: string) => {
      const email = `${name.toLowerCase()}-${newId()}@ai-marketing.example.test`;
      await staff.post(`/customers/${customerId}/invitations`, { email, role }).expect(201);
      await request(app.getHttpServer())
        .post('/auth/customer-invitations/accept')
        .send({ token: notifier.lastCustomerInvitationFor(email)!.token, name, password: PASSWORD })
        .expect(204);
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      return clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken);
    };

    luna = await customer('Luna Jewels');
    sol = await customer('Sol Rings');
    const recent = [await order(luna, 'Luna Jewels', 2, 3), await order(luna, 'Luna Jewels', 1)];
    const cancelled = await order(luna, 'Luna Jewels', 5);
    await prisma.inTenant(tenant.id, (tx) =>
      tx.order.update({ where: { id: cancelled.id }, data: { cancelledAt: new Date(), cancelReason: 'Changed their mind' } }),
    );
    await order(luna, 'Luna Jewels', 1, 120);
    solOrderNumber = (await order(sol, 'Sol Rings', 7)).number;

    const totals = await prisma.inTenant(tenant.id, (tx) =>
      tx.order.findMany({ where: { id: { in: recent.map((one) => one.id) } }, select: { total: true, currency: true } }),
    );
    lunaSpend = `${totals.reduce((sum, one) => sum.add(one.total), new Prisma.Decimal(0)).toFixed(2)} ${totals[0].currency}`;

    anna = await person(luna, 'Anna', 'owner');
    vic = await person(luna, 'Vic', 'viewer');
  }, SETUP_MS);

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  const path = (rest: string) => `/portal/customers/${luna}/ai${rest}`;
  const finished = (id: string) =>
    waitFor(async () => {
      const body = (await anna.get(path(`/runs/${id}`)).expect(200)).body as Result;
      return body.status === 'pending' ? undefined : body;
    });

  it("gives advice cards that cite only the customer's own figures (Review Focus 3)", async () => {
    fake.script(
      fakeToolUse('insights', {
        cards: [
          { title: 'Keep the rhythm', advice: 'You ordered twice this quarter.', figures: ['orders_90d', 'spend_90d'] },
          { title: 'Grow spend', advice: 'Spend is up on last quarter.', figures: ['spend_90d', 'made_up'] },
          { title: 'Invented', advice: 'A number from nowhere.', figures: ['made_up'] },
        ],
      }),
    );

    await vic.post(path('/marketing')).expect(403);
    const started = await anna.post(path('/marketing')).expect(202);
    expectDocumented(startedSchema, started.body);
    const result = await finished((started.body as { id: string }).id);
    expectDocumented(customerResultSchema, result);
    expect(result).toMatchObject({ status: 'done', credits: 5 });

    const cards = result.output!.cards;
    expect(cards.map((card) => card.title)).toEqual(['Keep the rhythm', 'Grow spend']);
    expect(cards[0].figures).toEqual([
      { key: 'orders_90d', label: expect.any(String), value: '2' },
      { key: 'spend_90d', label: expect.any(String), value: lunaSpend },
    ]);
    expect(cards[1].figures.map((figure) => figure.key)).toEqual(['spend_90d']);

    // The model saw this customer's figures only, as data.
    const question = fake.calls.at(-1)!.messages[0].content as string;
    expect(question).toMatch(/<customer_input>[\s\S]*orders_prev_90d[\s\S]*<\/customer_input>/);
    expect(question).toContain(lunaSpend);
    expect(question).toContain('Custom cast part');
    expect(question).not.toContain('Sol Rings');
    expect(question).not.toContain(String(solOrderNumber));
  });

  it('fails, and gives the credits back, when no card cites a real figure', async () => {
    const before = ((await anna.get(`/portal/customers/${luna}/credits`).expect(200)).body as { total: number }).total;
    fake.script(fakeToolUse('insights', { cards: [{ title: 'Invented', advice: 'From nowhere.', figures: ['made_up'] }] }));

    const started = await anna.post(path('/marketing')).expect(202);
    const result = await finished((started.body as { id: string }).id);

    expect(result).toMatchObject({ status: 'failed', output: null });
    await waitFor(async () => {
      const now = ((await anna.get(`/portal/customers/${luna}/credits`).expect(200)).body as { total: number }).total;
      return now === before ? now : undefined;
    });
    expect(await prisma.inTenant(tenantId, (tx) => tx.creditSpend.count({ where: { kind: 'give_back', customerId: luna } }))).toBe(1);
  });
});
