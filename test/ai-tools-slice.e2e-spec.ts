import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AI_PROVIDER } from '../src/modules/ai/ai-provider';
import { customerResultSchema } from '../src/modules/ai/customer-tools/customer-result-response';
import { fakeToolUse, fakeWebSearch } from '../src/modules/ai/fake-ai-provider';
import type { FakeAiProvider } from '../src/modules/ai/fake-ai-provider';
import type { FakeImageProvider } from '../src/modules/ai/fake-image-provider';
import { IMAGE_PROVIDER } from '../src/modules/ai/image-provider';
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
const TREND = 'https://trends.example.test/stacking-rings';
const AI_SWITCHES = ['ai_recommendations', 'ai_marketing', 'ai_brand', 'ai_images'];
const PRO = {
  key: 'pro',
  name: 'Pro',
  position: 1,
  monthly_price: '29.00',
  yearly_price: '290.00',
  discount_percent: '5',
  monthly_credits: 100,
  member_limit: 5,
  features: ['progress_emails', 'pay_later'],
  speeds: [{ key: 'rush', surcharge_percent: null }],
};

const fixture: JobRegistry = { jobs: { ...JOBS, 'ai.run': { ...JOBS['ai.run'], backoffMs: 10 } }, scheduled: SCHEDULED_JOBS };

interface Result {
  id: string;
  tool: string;
  status: string;
  credits: number;
  credits_given_back: boolean;
  parent_id: string | null;
  file_id: string | null;
  output: Record<string, unknown> | null;
}

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return {
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`),
  };
}
type Client = ReturnType<typeof clientFor>;

/**
 * The customer AI tools slice (AI 2 spec, "Done when" 1–8), in one workspace with the fake providers:
 * the switches on a paid plan and an image price, a brand profile, recommendations with a source,
 * insights from the customer's own figures, brand content, an image refined twice, the refusals that
 * charge nothing, credits back on a failure, and a delete that keeps the run log and the ledger.
 */
describe('ai: customer tools, end to end', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let claude: FakeAiProvider;
  let images: FakeImageProvider;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

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
    claude = worker.get<FakeAiProvider>(AI_PROVIDER);
    images = worker.get<FakeImageProvider>(IMAGE_PROVIDER);
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('sells the AI tools by plan and credits, within the AI limit, keeping every record', async () => {
    // --- The workspace: a 20.00 USD AI limit, the published cast part, shipping and tax for an order.
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const setLimit = (usd: string) =>
      prisma.inTenant(tenant.id, (tx) => tx.tenant.update({ where: { id: tenant.id }, data: { aiMonthlyLimitUsd: new Prisma.Decimal(usd) } }));
    await setLimit('20.00');
    const staffUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, staffUser.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: staffUser.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const speeds = (await staff.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] };
    await staff.patch(`/pricing/delivery-speeds/${speeds.data.find((speed) => speed.key === 'standard')!.id}`, { working_days: 10 }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '0' }] }).expect(200);

    const expiresOn = new Date(Date.now() + 30 * DAY_MS).toISOString().slice(0, 10);
    const customer = async (name: string, credits: number) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      await staff.post(`/payments/customers/${id}/credits`, { amount: credits, expires_on: expiresOn, reason: 'AI trial' }).expect(201);
      return id;
    };
    const owner = async (customerId: string, name: string) => {
      const email = `${name.toLowerCase()}-${newId()}@ai-slice.example.test`;
      await staff.post(`/customers/${customerId}/invitations`, { email, role: 'owner' }).expect(201);
      await request(app.getHttpServer())
        .post('/auth/customer-invitations/accept')
        .send({ token: notifier.lastCustomerInvitationFor(email)!.token, name, password: PASSWORD })
        .expect(204);
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      return clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken);
    };

    // --- Done when 1: staff turn on the four switches on Pro and price an image at 4 credits. Luna is on Pro.
    const pro = ((await staff.post('/payments/plans', PRO).expect(201)).body as { id: string }).id;
    await staff.patch(`/payments/plans/${pro}`, { features: [...PRO.features, ...AI_SWITCHES] }).expect(200);
    await staff.put('/settings/ai.toolPrices', { recommendations: 10, marketing: 5, brand_content: 3, image: 4 }).expect(200);
    const luna = await customer('Luna Jewels', 35);
    const mira = await customer('Mira Studio', 20);
    // The subscription flow has its own slice (payments-2-slice); here Luna simply has an active one.
    await prisma.inTenant(tenant.id, async (tx) => {
      const price = await tx.planPrice.findFirstOrThrow({ where: { planId: pro, interval: 'month', active: true } });
      await tx.customerSubscription.create({
        data: {
          customerId: luna,
          providerSubscriptionId: `sub_${randomBytes(6).toString('hex')}`,
          planPriceId: price.id,
          status: 'active',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * DAY_MS),
        },
      });
    });
    await staff.put(`/customers/${luna}/payment-terms`, { terms: 'pay_later' }).expect(200);
    const quote = (
      (
        await staff
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 3,
            file_version_id: cast.versionId,
            customer_id: luna,
          })
          .expect(201)
      ).body as { quote: { id: string } }
    ).quote;
    await staff
      .post('/orders', {
        customer_id: luna,
        lines: [{ quote_id: quote.id }],
        address: { name: 'Luna Jewels', line1: 'Main street 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
        shipping_method: 'courier',
      })
      .expect(201);
    const anna = await owner(luna, 'Anna');
    const miraOwner = await owner(mira, 'Mira');

    const ai = (rest: string) => `/portal/customers/${luna}/ai${rest}`;
    const balance = async () => ((await anna.get(`/portal/customers/${luna}/credits`).expect(200)).body as { total: number }).total;
    const finished = (id: string) =>
      waitFor(async () => {
        const body = (await anna.get(ai(`/runs/${id}`)).expect(200)).body as Result;
        return body.status === 'pending' ? undefined : body;
      });
    const run = async (tool: string, body: object = {}) => {
      const result = await finished(((await anna.post(ai(`/${tool}`), body).expect(202)).body as { id: string }).id);
      expectDocumented(customerResultSchema, result);
      return result;
    };

    // --- Done when 2: a brand profile, then recommendations with a focus, with their source, charged.
    await anna
      .put(ai('/brand-profile'), {
        name: 'Luna Jewels',
        sells: 'Hand-finished silver rings and pendants',
        audience: 'People buying a first piece of fine jewellery',
        tone: 'Warm and plain',
      })
      .expect(200);
    claude.script(
      fakeWebSearch([TREND]),
      fakeToolUse('recommendations', {
        ideas: [{ title: 'Stacking rings', why: 'Thin bands worn together are trending.', sources: [TREND, 'https://made-up.example.test'] }],
        advice: [{ text: 'Show pieces worn together.', sources: [TREND] }],
      }),
    );
    const recommendations = await run('recommendations', { focus: 'rings for a summer collection' });
    expect(recommendations).toMatchObject({
      status: 'done',
      credits: 10,
      output: {
        ideas: [{ title: 'Stacking rings', sources: [TREND] }],
        advice: [{ sources: [TREND] }],
      },
    });
    expect(await balance()).toBe(25);

    // --- Done when 3: four insight cards citing only Luna's own figures.
    claude.script(
      fakeToolUse('insights', {
        cards: [
          { title: 'Order rhythm', advice: 'One order this quarter.', figures: ['orders_90d'] },
          { title: 'Spend', advice: 'Spend this quarter.', figures: ['spend_90d'] },
          { title: 'Best seller', advice: 'Lead with your best seller.', figures: ['top_product_1'] },
          { title: 'Last order', advice: 'Come back soon.', figures: ['last_order_on', 'made_up'] },
        ],
      }),
    );
    const insights = await run('marketing');
    const cards = (insights.output as { cards: { figures: { key: string; value: string }[] }[] }).cards;
    expect(cards).toHaveLength(4);
    expect(cards.flatMap((card) => card.figures.map((figure) => figure.key))).toEqual(['orders_90d', 'spend_90d', 'top_product_1', 'last_order_on']);
    expect(cards[0].figures[0].value).toBe('1');
    expect(cards[2].figures[0].value).toBe('Custom cast part (3 pieces)');
    expect(claude.calls.at(-1)!.messages[0].content as string).not.toContain('Mira Studio');

    // --- Done when 4: brand content for one of Luna's products, in the profile's tone.
    const content = { names: ['Moonlit Band'], short: 'A slim silver band.', long: 'A slim silver band, finished by hand.', tags: ['silver'] };
    claude.script(fakeToolUse('brand_content', content));
    expect(await run('brand-content', { product_id: cast.productId })).toMatchObject({ status: 'done', credits: 3, output: content });
    expect(claude.calls.at(-1)!.messages[0].content as string).toContain('Warm and plain');

    // --- Done when 5: an image, refined twice; the history shows the chain, each step charged 4.
    const chain: string[] = [];
    for (const [description, written] of [
      ['a ring in a garden', 'A slim silver ring.'],
      ['thinner band', 'A slimmer silver ring.'],
      ['add a small star', 'A slim silver ring with a small star.'],
    ]) {
      claude.script(fakeToolUse('image_prompt', { prompt: written }));
      const image = await run('images', { description, ...(chain.length > 0 ? { from_id: chain.at(-1) } : {}) });
      expect(image).toMatchObject({ status: 'done', credits: 4, parent_id: chain.at(-1) ?? null, file_id: image.id });
      chain.push(image.id);
    }
    const history = await anna.get(ai('/results?tool=image')).expect(200);
    expectDocumented(pageSchema(customerResultSchema), history.body);
    expect((history.body as { data: Result[] }).data.map((one) => [one.id, one.parent_id, one.credits])).toEqual([
      [chain[2], chain[1], 4],
      [chain[1], chain[0], 4],
      [chain[0], null, 4],
    ]);
    expect(await balance()).toBe(5);

    // --- Done when 6: the free plan gets 403; too few credits get 409 and nothing taken; a failed run gives its credits back.
    await miraOwner.post(`/portal/customers/${mira}/ai/images`, { description: 'a ring' }).expect(403);
    const tooFew = await anna.post(ai('/recommendations'), {}).expect(409);
    expect(JSON.stringify(tooFew.body)).toContain('Not enough credits');
    expect(await balance()).toBe(5);
    claude.script(fakeToolUse('image_prompt', { prompt: 'A pendant.' }));
    images.fail(new Error('image service down'));
    const failed = await run('images', { description: 'a pendant' });
    expect(failed).toMatchObject({ status: 'failed', credits: 4, file_id: null });
    await waitFor(async () => ((await finished(failed.id)).credits_given_back ? true : undefined));
    expect(await balance()).toBe(5);

    // --- Done when 7: with the workspace's AI limit used, a run is refused and no credits are taken.
    await setLimit('0.01');
    const limited = await anna.post(ai('/brand-content'), { description: 'A silver ring' }).expect(409);
    expect(JSON.stringify(limited.body)).toContain("This month's AI limit is used");
    expect(await balance()).toBe(5);
    await setLimit('20.00');

    // --- Done when 8: deleting an image removes it and its file; the run log and the ledger keep their rows.
    const ledgerBefore = await prisma.inTenant(tenant.id, (tx) => tx.creditEntry.count({ where: { customerId: luna } }));
    await anna.delete(ai(`/results/${chain[1]}`)).expect(204);
    await anna.get(ai(`/runs/${chain[1]}`)).expect(404);
    await anna.get(`/portal/customers/${luna}/files/${chain[1]}`).expect(404);
    const after = (await anna.get(ai('/results?tool=image')).expect(200)).body as { data: Result[] };
    expect(after.data.map((one) => one.id)).toEqual([failed.id, chain[2], chain[0]]);
    expect(after.data[1].parent_id).toBe(chain[1]);
    const kept = await prisma.inTenant(tenant.id, async (tx) => ({
      run: await tx.aiRun.count({ where: { id: chain[1] } }),
      result: await tx.aiRunResult.count({ where: { runId: chain[1] } }),
      ledger: await tx.creditEntry.count({ where: { customerId: luna } }),
    }));
    expect(kept).toEqual({ run: 1, result: 1, ledger: ledgerBefore });
    expect(await balance()).toBe(5);
  }, 120_000);
});
