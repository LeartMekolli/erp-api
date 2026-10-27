import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { paymentAccountResponseSchema } from '../src/modules/payments/payment-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};

/** Each workspace stores its own sealed Stripe keys (Payments plan, Task 1). */
describe('payments: the workspace account', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;

  const http = () => request(app.getHttpServer());

  async function workspace(): Promise<{ id: string; owner: string; member: string }> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    return {
      id: tenant.id,
      owner: (await tokens.issueForUser(tenant.id, owner.id)).accessToken,
      member: (await tokens.issueForUser(tenant.id, member.id)).accessToken,
    };
  }

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('shows a workspace without keys as not configured, with its webhook addresses', async () => {
    const ws = await workspace();

    const res = await http().get('/payments/account').set('Authorization', `Bearer ${ws.owner}`).expect(200);

    expectDocumented(paymentAccountResponseSchema, res.body);
    expect(res.body).toEqual({
      configured: false,
      publishable_key: null,
      mode: null,
      webhook_urls: {
        payments: `/webhooks/payments/${ws.id}`,
        connect: `/webhooks/payments/${ws.id}/connect`,
      },
    });
  });

  it('stores the keys and shows no secret, with the mode from the key prefix', async () => {
    const ws = await workspace();

    await http().put('/payments/account').set('Authorization', `Bearer ${ws.owner}`).send(KEYS).expect(200);
    const res = await http().get('/payments/account').set('Authorization', `Bearer ${ws.owner}`).expect(200);

    expectDocumented(paymentAccountResponseSchema, res.body);
    expect(res.body).toMatchObject({ configured: true, mode: 'test', publishable_key: KEYS.publishable_key });
    const raw = JSON.stringify(res.body);
    for (const secret of [KEYS.secret_key, KEYS.webhook_secret, KEYS.connect_webhook_secret]) {
      expect(raw).not.toContain(secret);
    }
  });

  it('reads a live key as live mode', async () => {
    const ws = await workspace();

    await http()
      .put('/payments/account')
      .set('Authorization', `Bearer ${ws.owner}`)
      .send({ ...KEYS, secret_key: 'sk_live_51SecretValueEEEE' })
      .expect(200);

    const res = await http().get('/payments/account').set('Authorization', `Bearer ${ws.owner}`).expect(200);
    expect((res.body as { mode: string }).mode).toBe('live');
  });

  it('keeps the keys sealed at rest', async () => {
    const ws = await workspace();
    await http().put('/payments/account').set('Authorization', `Bearer ${ws.owner}`).send(KEYS).expect(200);

    const row = await prisma.inTenant(ws.id, (tx) => tx.paymentAccount.findFirstOrThrow());

    for (const [stored, plain] of [
      [row.secretKey, KEYS.secret_key],
      [row.webhookSecret, KEYS.webhook_secret],
      [row.connectWebhookSecret, KEYS.connect_webhook_secret],
    ] as const) {
      expect(Buffer.from(stored).includes(Buffer.from(plain))).toBe(false);
    }
  });

  it('audits the change without any secret', async () => {
    const ws = await workspace();
    await http().put('/payments/account').set('Authorization', `Bearer ${ws.owner}`).send(KEYS).expect(200);

    const entries = await prisma.inTenant(ws.id, (tx) => tx.auditEntry.findMany({ where: { subjectType: 'payment_account' } }));

    expect(entries).toHaveLength(1);
    const raw = JSON.stringify(entries);
    for (const secret of [KEYS.secret_key, KEYS.webhook_secret, KEYS.connect_webhook_secret]) {
      expect(raw).not.toContain(secret);
    }
  });

  it('replaces the keys when set again', async () => {
    const ws = await workspace();
    await http().put('/payments/account').set('Authorization', `Bearer ${ws.owner}`).send(KEYS).expect(200);

    await http()
      .put('/payments/account')
      .set('Authorization', `Bearer ${ws.owner}`)
      .send({ ...KEYS, publishable_key: 'pk_test_51NewEEEE' })
      .expect(200);

    const res = await http().get('/payments/account').set('Authorization', `Bearer ${ws.owner}`).expect(200);
    expect((res.body as { publishable_key: string }).publishable_key).toBe('pk_test_51NewEEEE');
    expect(await prisma.inTenant(ws.id, (tx) => tx.paymentAccount.count())).toBe(1);
  });

  it('refuses a key of the wrong kind', async () => {
    const ws = await workspace();

    await http()
      .put('/payments/account')
      .set('Authorization', `Bearer ${ws.owner}`)
      .send({ ...KEYS, secret_key: KEYS.webhook_secret })
      .expect(400);
    await http()
      .put('/payments/account')
      .set('Authorization', `Bearer ${ws.owner}`)
      .send({ ...KEYS, publishable_key: KEYS.secret_key })
      .expect(400);
  });

  it('is for staff with payment.setup only', async () => {
    const ws = await workspace();

    await http().get('/payments/account').set('Authorization', `Bearer ${ws.member}`).expect(403);
    await http().put('/payments/account').set('Authorization', `Bearer ${ws.member}`).send(KEYS).expect(403);
    await http().get('/payments/account').expect(401);
  });
});
