import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { planResponseSchema } from '../src/modules/payments/plans/plan-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};

const PRO = {
  key: 'pro',
  name: 'Pro',
  description: 'For brands that order every week.',
  position: 1,
  monthly_price: '29.00',
  yearly_price: '290.00',
  discount_percent: '5',
  monthly_credits: 100,
  member_limit: 5,
  features: ['progress_emails'],
  speeds: [{ key: 'express', surcharge_percent: '15' }],
};

interface PlanBody {
  id: string;
  key: string;
  is_default: boolean;
  published: boolean;
  monthly_price: string | null;
  speeds: { key: string; name: string; surcharge_percent: string | null }[];
}

/** Plans are workspace data, priced at Stripe (Payments 2 plan, Task 1). */
describe('payments: plans', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakePaymentProvider;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;

  const http = () => request(app.getHttpServer());

  async function workspace(): Promise<{ id: string; owner: string; member: string }> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const ws = {
      id: tenant.id,
      owner: (await tokens.issueForUser(tenant.id, owner.id)).accessToken,
      member: (await tokens.issueForUser(tenant.id, member.id)).accessToken,
    };
    for (const speed of [
      { key: 'standard', name: 'Standard', surcharge_percent: '0', working_days: 10, is_default: true },
      { key: 'express', name: 'Express', surcharge_percent: '25', working_days: 5 },
      { key: 'rush', name: 'Rush', surcharge_percent: '60', working_days: 2 },
    ]) {
      await http().post('/pricing/delivery-speeds').set('Authorization', `Bearer ${ws.owner}`).send(speed).expect(201);
    }
    return ws;
  }

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    fake = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('gives every workspace one free default plan', async () => {
    const ws = await workspace();

    const res = await http().get('/payments/plans').set('Authorization', `Bearer ${ws.member}`).expect(200);

    const plans = (res.body as { data: PlanBody[] }).data;
    expect(plans).toHaveLength(1);
    expectDocumented(planResponseSchema, plans[0]);
    expect(plans[0]).toMatchObject({
      key: 'starter',
      name: 'Starter',
      is_default: true,
      status: 'active',
      monthly_price: null,
      yearly_price: null,
      discount_percent: '0',
      monthly_credits: 0,
      member_limit: null,
      features: ['pay_later'],
      speeds: [],
      published: true,
    });
  });

  it('creates a paid plan and publishes its prices once the workspace has keys', async () => {
    const ws = await workspace();

    const created = await http().post('/payments/plans').set('Authorization', `Bearer ${ws.owner}`).send(PRO).expect(201);

    expectDocumented(planResponseSchema, created.body);
    expect(created.body).toMatchObject({
      key: 'pro',
      is_default: false,
      monthly_price: '29.00',
      yearly_price: '290.00',
      discount_percent: '5',
      monthly_credits: 100,
      member_limit: 5,
      features: ['progress_emails'],
      speeds: [{ key: 'express', name: 'Express', surcharge_percent: '15' }],
      published: false,
    });
    const raw = JSON.stringify(created.body);
    expect(raw).not.toContain('fake_product_');
    expect(raw).not.toContain('fake_price_');

    await http().put('/payments/account').set('Authorization', `Bearer ${ws.owner}`).send(KEYS).expect(200);
    await http().post('/payments/plans/sync').set('Authorization', `Bearer ${ws.owner}`).expect(204);

    const listed = await http().get('/payments/plans').set('Authorization', `Bearer ${ws.owner}`).expect(200);
    const pro = (listed.body as { data: PlanBody[] }).data.find((plan) => plan.key === 'pro')!;
    expect(pro.published).toBe(true);

    const prices = await prisma.inTenant(ws.id, (tx) =>
      tx.planPrice.findMany({ where: { planId: pro.id }, orderBy: { interval: 'asc' } }),
    );
    expect(prices.map((row) => [row.interval, row.amount.toFixed(2), row.active])).toEqual([
      ['month', '29.00', true],
      ['year', '290.00', true],
    ]);
    const product = await prisma.inTenant(ws.id, (tx) => tx.plan.findUniqueOrThrow({ where: { id: pro.id } }));
    for (const row of prices) {
      expect(fake.price(row.providerPriceId!)).toMatchObject({
        productId: product.providerProductId,
        currency: 'EUR',
        interval: row.interval,
      });
      expect(fake.price(row.providerPriceId!).amount.toFixed(2)).toBe(row.amount.toFixed(2));
    }
  });

  it('keeps the old price for existing subscribers when the price changes', async () => {
    const ws = await workspace();
    await http().put('/payments/account').set('Authorization', `Bearer ${ws.owner}`).send(KEYS).expect(200);
    const pro = (await http().post('/payments/plans').set('Authorization', `Bearer ${ws.owner}`).send(PRO).expect(201))
      .body as PlanBody;
    expect(pro.published).toBe(true);

    const changed = await http()
      .patch(`/payments/plans/${pro.id}`)
      .set('Authorization', `Bearer ${ws.owner}`)
      .send({ monthly_price: '35.00' })
      .expect(200);

    expect(changed.body).toMatchObject({ monthly_price: '35.00', yearly_price: '290.00', published: true });
    const monthly = await prisma.inTenant(ws.id, (tx) =>
      tx.planPrice.findMany({ where: { planId: pro.id, interval: 'month' }, orderBy: { id: 'asc' } }),
    );
    expect(monthly.map((row) => [row.amount.toFixed(2), row.active])).toEqual([
      ['29.00', false],
      ['35.00', true],
    ]);
    expect(monthly[0].providerPriceId).toMatch(/^fake_price_/);
    expect(monthly[1].providerPriceId).toMatch(/^fake_price_/);
    expect(monthly[1].providerPriceId).not.toBe(monthly[0].providerPriceId);
  });

  it('edits everything but the price without a new price, and audits each change', async () => {
    const ws = await workspace();
    const pro = (await http().post('/payments/plans').set('Authorization', `Bearer ${ws.owner}`).send(PRO).expect(201))
      .body as PlanBody;

    const changed = await http()
      .patch(`/payments/plans/${pro.id}`)
      .set('Authorization', `Bearer ${ws.owner}`)
      .send({ discount_percent: '3', speeds: [{ key: 'express', surcharge_percent: null }, { key: 'rush', surcharge_percent: '40' }] })
      .expect(200);

    expect(changed.body).toMatchObject({
      discount_percent: '3',
      speeds: [
        { key: 'express', name: 'Express', surcharge_percent: null },
        { key: 'rush', name: 'Rush', surcharge_percent: '40' },
      ],
    });
    expect(await prisma.inTenant(ws.id, (tx) => tx.planPrice.count({ where: { planId: pro.id } }))).toBe(2);
    const entries = await prisma.inTenant(ws.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'plan.changed', subjectId: pro.id }, orderBy: { id: 'asc' } }),
    );
    expect(entries).toHaveLength(2);
    expect(entries[1].before).toMatchObject({ discount_percent: '5' });
    expect(entries[1].after).toMatchObject({ discount_percent: '3' });
  });

  it('archives a paid plan but never the default one', async () => {
    const ws = await workspace();
    const pro = (await http().post('/payments/plans').set('Authorization', `Bearer ${ws.owner}`).send(PRO).expect(201))
      .body as PlanBody;
    const plans = (await http().get('/payments/plans').set('Authorization', `Bearer ${ws.owner}`).expect(200)).body as {
      data: PlanBody[];
    };
    const starter = plans.data.find((plan) => plan.is_default)!;

    await http().post(`/payments/plans/${starter.id}/archive`).set('Authorization', `Bearer ${ws.owner}`).expect(409);
    const archived = await http().post(`/payments/plans/${pro.id}/archive`).set('Authorization', `Bearer ${ws.owner}`).expect(200);

    expect(archived.body).toMatchObject({ status: 'archived' });
  });

  it('refuses unknown speeds and features, a taken key, and a paid plan without prices', async () => {
    const ws = await workspace();
    const post = (body: object) => http().post('/payments/plans').set('Authorization', `Bearer ${ws.owner}`).send(body);

    await post({ ...PRO, speeds: [{ key: 'teleport', surcharge_percent: null }] }).expect(400);
    await post({ ...PRO, features: ['teleport'] }).expect(400);
    await post({ ...PRO, monthly_price: null, yearly_price: null }).expect(400);
    await post({ ...PRO, monthly_price: '0' }).expect(400);
    await post({ ...PRO, member_limit: 0 }).expect(400);
    await post({ ...PRO, discount_percent: '101' }).expect(400);
    await post(PRO).expect(201);
    await post(PRO).expect(409);
  });

  it('is for staff: members read plans, only plan.write changes them', async () => {
    const ws = await workspace();

    await http().post('/payments/plans').set('Authorization', `Bearer ${ws.member}`).send(PRO).expect(403);
    await http().post('/payments/plans/sync').set('Authorization', `Bearer ${ws.member}`).expect(403);
    await http().get('/payments/plans').expect(401);
  });
});
