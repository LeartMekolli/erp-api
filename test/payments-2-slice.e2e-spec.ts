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
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { AllowancesService } from '../src/modules/payments/credits/allowances.service';
import { CampaignsService } from '../src/modules/payments/credits/campaigns.service';
import { CreditsService } from '../src/modules/payments/credits/credits.service';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { planOf } from '../src/modules/payments/plans/plan-of';
import { measuredDesign } from './catalog-fixtures';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { sendEvent } from './payment-webhooks';
import { pricedCastPart } from './pricing-fixtures';
import { startTestWorker } from './worker-harness';

const PASSWORD = 'a-long-customer-password';
const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const PRO = {
  key: 'pro',
  name: 'Pro',
  position: 1,
  monthly_price: '29.00',
  yearly_price: '290.00',
  discount_percent: '5',
  monthly_credits: 100,
  member_limit: 5,
  features: ['progress_emails'],
  speeds: [{ key: 'express', surcharge_percent: null }],
};
const BUSINESS = {
  key: 'business',
  name: 'Business',
  position: 2,
  monthly_price: '99.00',
  yearly_price: '990.00',
  discount_percent: '10',
  monthly_credits: 400,
  member_limit: null,
  features: ['progress_emails', 'pay_later'],
  speeds: [
    { key: 'express', surcharge_percent: null },
    { key: 'rush', surcharge_percent: '20' },
  ],
};
const DAY = 24 * 3_600_000;
const d = (value: string) => new Prisma.Decimal(value);

/** The real jobs, with a tiny backoff so a retry happens within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'payments.event': { ...JOBS['payments.event'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

interface Balance {
  total: number;
  by_source: { campaign: number; staff: number; allowance: number; pack: number };
}
interface Adjustment {
  kind: string;
  percent: string;
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

/**
 * The plans and credits slice (Payments 2 spec, "Done when" 1–9), in one workspace with the fake
 * provider: plans and a price change, Starter's limits and trial credits, a pack on Starter, a
 * subscription with its campaign credits, an upgrade and a scheduled downgrade, a failed renewal and
 * the drop, spends in order, a campaign that stops at its budget, and replays that change nothing, with
 * both ledgers append-only and balanced.
 */
describe('payments: plans and credits, end to end', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakePaymentProvider;
  let credits: CreditsService;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none.
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
    fake = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
    credits = app.get(CreditsService);
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('sells plans, packs and campaigns, and spends credits, every step journalled and balanced', async () => {
    // --- The workspace: the priced cast part, standard (default), express at 25 % and rush at 30 %; payment keys.
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/pricing/delivery-speeds', { key: 'express', name: 'Express', surcharge_percent: '25' }).expect(201);
    await staff.put('/payments/account', KEYS).expect(200);

    const plans = (await staff.get('/payments/plans').expect(200)).body as { data: { id: string; is_default: boolean }[] };
    const starter = plans.data.find((plan) => plan.is_default)!.id;
    await staff.patch(`/payments/plans/${starter}`, { monthly_credits: 10 }).expect(200);

    const send = (type: string, objectId: string) => sendEvent(app, tenant.id, { id: `evt_${newId().replaceAll('-', '')}`, type, objectId });
    const told = (eventKey: string, subjectId: string) =>
      prisma.inTenant(tenant.id, (tx) => tx.notification.findMany({ where: { eventKey, subjectId } }));
    const balance = async (customerId: string) => (await staff.get(`/payments/customers/${customerId}/credits`).expect(200)).body as Balance;
    const planKey = async (customerId: string) => (await prisma.inTenant(tenant.id, (tx) => planOf(tx, customerId))).key;
    const checkoutIdOf = (body: unknown) => (body as { url: string }).url.split('/').at(-1)!;
    const journals = (providerObjectId: string) =>
      prisma.inTenant(tenant.id, (tx) => tx.ledgerJournal.findMany({ where: { providerObjectId }, include: { lines: true }, orderBy: { id: 'asc' } }));
    const sumOf = (lines: { amount: Prisma.Decimal }[]) => lines.reduce((sum, line) => sum.plus(line.amount), d('0')).toFixed(2);
    const cube = (fileVersionId: string, delivery_speed?: string) => ({
      product_id: cast.productId,
      options: { material: 'brass', finish: 'raw' },
      size: { scale: '1' },
      file_version_id: fileVersionId,
      quantity: 1,
      ...(delivery_speed ? { delivery_speed } : {}),
    });
    /** A staff quote for the customer, read back with its breakdown: the adjustments as [kind, percent]. */
    const staffAdjustments = async (customerId: string, delivery_speed: string) => {
      const created = await staff.post('/pricing/quotes', { ...cube(cast.versionId, delivery_speed), customer_id: customerId }).expect(201);
      const view = await staff.get(`/pricing/quotes/${(created.body as { quote: { id: string } }).quote.id}`).expect(200);
      return (view.body as { breakdown: { adjustments: Adjustment[] } }).breakdown.adjustments.map((line) => [line.kind, line.percent]);
    };
    const portalLabels = (body: unknown) => (body as { quote: { lines: { label: string }[] } }).quote.lines.map((line) => line.label);
    /** A customer's owner, invited and signed in. */
    const ownerOf = async (customerId: string) => {
      const email = `owner-${newId()}@slice.example.test`;
      await staff.post(`/customers/${customerId}/invitations`, { email, role: 'owner' }).expect(201);
      await request(app.getHttpServer())
        .post('/auth/customer-invitations/accept')
        .send({ token: notifier.lastCustomerInvitationFor(email)!.token, name: 'Owner', password: PASSWORD })
        .expect(204);
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      return { id: user.id, client: clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken) };
    };
    const customer = async (body: object) => ((await staff.post('/customers', body).expect(201)).body as { id: string }).id;

    // --- Done when 1: Pro and Business, published. A new yearly price for Pro; the old one is kept.
    const pro = (await staff.post('/payments/plans', PRO).expect(201)).body as { id: string; published: boolean };
    const business = (await staff.post('/payments/plans', BUSINESS).expect(201)).body as { id: string; published: boolean };
    expect([pro.published, business.published]).toEqual([true, true]);
    expect((await staff.patch(`/payments/plans/${pro.id}`, { yearly_price: '300.00' }).expect(200)).body).toMatchObject({
      yearly_price: '300.00',
      published: true,
    });
    const yearly = await prisma.inTenant(tenant.id, (tx) => tx.planPrice.findMany({ where: { planId: pro.id, interval: 'year' } }));
    expect(yearly.map((price) => [price.amount.toFixed(2), price.active, price.providerPriceId !== null]).sort()).toEqual([
      ['290.00', false, true],
      ['300.00', true, true],
    ]);

    // --- Done when 2: Anna, on Starter, is offered only the standard speed and no plan discount, and has her trial credits.
    const luna = await customer({ name: 'Luna Jewels' });
    const anna = await ownerOf(luna);
    const lunaDesign = (await measuredDesign(prisma, tenant.id, anna.id, { customerId: luna })).versionId;
    expect(JSON.stringify((await anna.client.post(`/portal/customers/${luna}/quotes`, cube(lunaDesign, 'express')).expect(400)).body)).toContain(
      'Starter',
    );
    expect(portalLabels((await anna.client.post(`/portal/customers/${luna}/quotes`, cube(lunaDesign)).expect(201)).body)).not.toContain(
      'plan_discount',
    );
    await app.get(AllowancesService).grantDueInWorkspace(tenant.id, new Date());
    expect(await balance(luna)).toMatchObject({ total: 10, by_source: { allowance: 10 } });

    // --- Done when 3: Anna buys a pack, still on Starter; the credits arrive once, the sale is journalled and balanced.
    const pack100 = ((await staff.post('/payments/credit-packs', { name: '100 credits', credits: 100, price: '10.00', valid_days: 365 }).expect(201))
      .body as { id: string }).id;
    await staff.post('/payments/credit-packs', { name: '500 credits', credits: 500, price: '40.00', valid_days: 365, position: 1 }).expect(201);
    const lunaPack = checkoutIdOf((await anna.client.post(`/portal/customers/${luna}/credit-packs/${pack100}/buy`).expect(200)).body);
    fake.completeCheckout(lunaPack);
    await send('checkout.session.completed', lunaPack);
    await send('checkout.session.completed', lunaPack);
    expect(await planKey(luna)).toBe('starter');
    expect(await balance(luna)).toMatchObject({ total: 110, by_source: { allowance: 10, pack: 100 } });
    const packJournals = await journals(lunaPack);
    expect(packJournals.map((journal) => [journal.kind, sumOf(journal.lines)])).toEqual([
      ['pack_billed', '0.00'],
      ['payment_received', '0.00'],
      ['provider_fee', '0.00'],
    ]);

    // --- Done when 4: Brightline subscribes to Pro; its monthly credits and the running Pro campaign's arrive.
    const welcome = ((
      await staff
        .post('/payments/campaigns', {
          name: 'Welcome to Pro',
          credits_per_customer: 50,
          credit_days: 60,
          starts_at: new Date(Date.now() - 60_000).toISOString(),
          ends_at: new Date(Date.now() + 30 * DAY).toISOString(),
          budget: 5000,
          targets: { plan_ids: [pro.id] },
        })
        .expect(201)
    ).body as { id: string }).id;
    await staff.post(`/payments/campaigns/${welcome}/activate`).expect(200);

    const brightline = await customer({ name: 'Brightline', customer_group_id: cast.tradeGroupId });
    await staff.put(`/customers/${brightline}/payment-terms`, { terms: 'pay_later', days_to_pay: 30, credit_limit: null }).expect(200);
    const bea = await ownerOf(brightline);
    const brightlineDesign = (await measuredDesign(prisma, tenant.id, bea.id, { customerId: brightline })).versionId;
    // A pack bought on Starter, which the drop to free in Done when 6 must not take away.
    const brightlinePack = checkoutIdOf((await bea.client.post(`/portal/customers/${brightline}/credit-packs/${pack100}/buy`).expect(200)).body);
    fake.completeCheckout(brightlinePack);
    await send('checkout.session.completed', brightlinePack);

    const asked = await bea.client.post(`/portal/customers/${brightline}/subscription/checkout`, { plan_id: pro.id, interval: 'month' }).expect(200);
    const subscriptionCheckout = checkoutIdOf(asked.body);
    const { subscriptionId, invoiceId: firstInvoice } = fake.completeSubscriptionCheckout(subscriptionCheckout);
    await send('checkout.session.completed', subscriptionCheckout);
    await send('invoice.paid', firstInvoice);

    expect((await bea.client.get(`/portal/customers/${brightline}/subscription`).expect(200)).body).toMatchObject({
      plan: { key: 'pro' },
      status: 'active',
    });
    expect(await balance(brightline)).toMatchObject({ by_source: { allowance: 100, campaign: 50, pack: 100 } });
    expect(await staffAdjustments(brightline, 'express')).toEqual([
      ['customer_group', '-10'],
      ['plan', '5'],
      ['delivery_speed', '25'],
    ]);
    const portalQuote = await bea.client.post(`/portal/customers/${brightline}/quotes`, cube(brightlineDesign, 'express')).expect(201);
    expect(portalLabels(portalQuote.body)).toEqual(expect.arrayContaining(['your_discount', 'plan_discount', 'delivery_speed']));

    // --- Done when 5: the upgrade to Business, at once once paid, with the top-up and rush at Business's surcharge.
    const change = (plan_id: string) => bea.client.post(`/portal/customers/${brightline}/subscription/change`, { plan_id, interval: 'month' });
    await change(business.id).expect(202);
    const { invoiceId: upgradeInvoice } = fake.settleUpgrade(subscriptionId, true);
    await send('customer.subscription.updated', subscriptionId);
    await send('invoice.paid', upgradeInvoice);
    expect(await planKey(brightline)).toBe('business');
    const topUps = await prisma.inTenant(tenant.id, (tx) =>
      tx.creditGrant.findMany({ where: { customerId: brightline, sourceKey: { startsWith: 'topup:' } } }),
    );
    expect(topUps.map((grant) => grant.amount)).toEqual([300]);
    expect(await staffAdjustments(brightline, 'rush')).toEqual([
      ['customer_group', '-10'],
      ['plan', '10'],
      ['delivery_speed', '20'],
    ]);

    // A downgrade to Pro is scheduled for the period end and shown; choosing Business again takes it back.
    const end = fake.subscription(subscriptionId).currentPeriodEnd.toISOString();
    expect((await change(pro.id).expect(200)).body).toMatchObject({ plan: { key: 'business' }, change: { plan: { key: 'pro' }, on: end } });
    expect(await planKey(brightline)).toBe('business');
    expect((await change(business.id).expect(200)).body).toMatchObject({ plan: { key: 'business' }, change: null });

    // --- Done when 6: a failed renewal keeps Business while past due; when the provider gives up, Starter, and staff are told.
    const { invoiceId: renewal } = fake.renew(subscriptionId, false);
    await send('invoice.payment_failed', renewal!);
    await send('customer.subscription.updated', subscriptionId);
    expect((await bea.client.get(`/portal/customers/${brightline}/subscription`).expect(200)).body).toMatchObject({
      plan: { key: 'business' },
      status: 'past_due',
    });
    expect(await planKey(brightline)).toBe('business');
    expect(await told('subscription.payment_failed', brightline)).toHaveLength(1);

    fake.giveUp(subscriptionId);
    await send('customer.subscription.deleted', subscriptionId);
    expect(await planKey(brightline)).toBe('starter');
    const staffTold = await told('subscription.ended.staff', brightline);
    expect(staffTold).toHaveLength(1);
    expect(staffTold[0].payload).toMatchObject({ customer: 'Brightline', plan: 'Business', pay_later: 'yes' });
    // The paid allowance is gone; the pack's and the campaign's credits stay.
    const dropped = await balance(brightline);
    expect(dropped.by_source).toMatchObject({ campaign: 50, pack: 100 });
    expect(dropped.by_source.allowance).toBeLessThanOrEqual(10);

    // --- Done when 7: spends take the campaign first, then the allowance, then packs; too much is refused; a give-back restores.
    const amount = dropped.by_source.campaign + dropped.by_source.allowance + 5;
    const { spendId } = await credits.spend(tenant.id, brightline, { amount, reason: 'Image generation', reference: 'slice-spend' });
    const taken = await prisma.inTenant(tenant.id, (tx) => tx.creditEntry.findMany({ where: { spendId }, include: { grant: true } }));
    const bySource = (source: string) => taken.filter((entry) => entry.grant.source === source).reduce((sum, entry) => sum + entry.amount, 0);
    // `0 -`, not unary minus: no allowance left would be -0, which toEqual tells apart from the 0 summed.
    expect([bySource('campaign'), bySource('allowance'), bySource('pack')]).toEqual([-50, 0 - dropped.by_source.allowance, -5]);
    await expect(
      credits.spend(tenant.id, brightline, { amount: dropped.total - amount + 1, reason: 'Too much', reference: 'slice-too-much' }),
    ).rejects.toThrow('Not enough credits');
    await credits.giveBack(tenant.id, spendId);
    expect(await balance(brightline)).toEqual(dropped);

    // --- Done when 8: a campaign whose budget fits two customers grants to two and stops; staff are told once.
    const named = [await customer({ name: 'Kai Studio' }), await customer({ name: 'Max Labs' }), await customer({ name: 'Zed Works' })];
    const spring = ((
      await staff
        .post('/payments/campaigns', {
          name: 'Spring',
          credits_per_customer: 50,
          credit_days: 30,
          starts_at: new Date(Date.now() - 60_000).toISOString(),
          ends_at: new Date(Date.now() + 30 * DAY).toISOString(),
          budget: 100,
          targets: { customer_ids: named },
        })
        .expect(201)
    ).body as { id: string }).id;
    expect((await staff.post(`/payments/campaigns/${spring}/activate`).expect(200)).body).toMatchObject({
      granted_customers: 2,
      granted_credits: 100,
      budget_left: 0,
    });
    const springGrants = await prisma.inTenant(tenant.id, (tx) => tx.creditGrant.count({ where: { campaignId: spring } }));
    expect(springGrants).toBe(2);
    expect(await told('campaign.budget_used', spring)).toHaveLength(1);

    // --- Done when 9: replayed webhooks change nothing.
    const snapshot = () =>
      prisma.inTenant(tenant.id, async (tx) => ({
        journals: await tx.ledgerJournal.count(),
        grants: await tx.creditGrant.count(),
        entries: await tx.creditEntry.count(),
        // Its state, not `updated_at`, which a replayed sync may touch.
        subscription: await tx.customerSubscription.findFirstOrThrow({
          where: { customerId: brightline },
          select: { providerSubscriptionId: true, planPriceId: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
        }),
      }));
    // The worker runs the real scheduled jobs: grant what they would, so one landing in the window below
    // finds nothing left to grant and only the replays could change the counts.
    await app.get(AllowancesService).grantDueInWorkspace(tenant.id, new Date());
    await app.get(CampaignsService).run(tenant.id);
    const before = await snapshot();
    await send('invoice.paid', firstInvoice);
    await send('invoice.paid', upgradeInvoice);
    await send('checkout.session.completed', subscriptionCheckout);
    await send('customer.subscription.updated', subscriptionId);
    await send('customer.subscription.deleted', subscriptionId);
    await send('checkout.session.completed', lunaPack);
    expect(await snapshot()).toEqual(before);

    // The money ledger and the credit ledger refuse changes and deletes (ADR 0003), and every journal sums to zero.
    await expect(prisma.inTenant(tenant.id, (tx) => tx.$executeRaw`UPDATE ledger_line SET amount = amount`)).rejects.toThrow(/permission denied/i);
    await expect(prisma.inTenant(tenant.id, (tx) => tx.$executeRaw`DELETE FROM ledger_journal`)).rejects.toThrow(/permission denied/i);
    await expect(prisma.inTenant(tenant.id, (tx) => tx.$executeRaw`UPDATE credit_entry SET amount = amount`)).rejects.toThrow(/permission denied/i);
    await expect(prisma.inTenant(tenant.id, (tx) => tx.$executeRaw`DELETE FROM credit_grant`)).rejects.toThrow(/permission denied/i);
    const all = await prisma.inTenant(tenant.id, (tx) => tx.ledgerJournal.findMany({ include: { lines: true } }));
    expect(all.map((journal) => journal.kind)).toEqual(expect.arrayContaining(['plan_billed', 'pack_billed']));
    for (const journal of all) {
      expect([journal.kind, sumOf(journal.lines)]).toEqual([journal.kind, '0.00']);
    }
  });
});
