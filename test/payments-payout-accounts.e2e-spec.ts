import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { partnerResponseSchema } from '../src/modules/partners/partner-response';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { PaymentAccountService } from '../src/modules/payments/payment-account.service';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { payoutAccountResponseSchema, payoutLinkResponseSchema } from '../src/modules/payments/payment-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { eventBody, postRaw, sendEvent, webhookPath } from './payment-webhooks';
import { startTestWorker } from './worker-harness';

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};

/** The real jobs, with a tiny backoff so a retry happens within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'payments.event': { ...JOBS['payments.event'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

/**
 * Partner payout accounts (Payments plan, Task 11): a partner's owner connects a Stripe account to be
 * paid through, onboarding at the provider; the provider tells us when it is ready. Staff and the
 * partner see its state, and the partner never sees the provider's id.
 */
describe('payments: partner payout accounts', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakePaymentProvider;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;

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
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'partner', organisationId: partnerId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /** The workspace's payment keys; CastCo with an owner and a member; MetalWorks with its own owner. */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    await staff.put('/payments/account', KEYS).expect(200);
    const partner = async (name: string) =>
      ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
    const castco = await partner('CastCo');
    const metalworks = await partner('MetalWorks');
    return {
      id: tenant.id,
      staff,
      staffMember: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      castco,
      castcoOwner: await partnerPerson(tenant.id, castco, 'owner'),
      castcoMember: await partnerPerson(tenant.id, castco, 'member'),
      metalworksOwner: await partnerPerson(tenant.id, metalworks, 'owner'),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const portal = (partnerId: string) => `/partner-portal/partners/${partnerId}/payout-account`;
  const staffPath = (partnerId: string) => `/partners/${partnerId}/payout-account`;
  const row = (tenant: Tenant) =>
    prisma.inTenant(tenant.id, (tx) => tx.partnerPayoutAccount.findUniqueOrThrow({ where: { partnerId: tenant.castco } }));

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JOB_REGISTRY)
      .useValue(fixture)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    fake = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
    // The worker applies the webhooks with its own provider instance, which sees what the app's saw.
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it("gives the partner's owner an onboarding link, on one account however often it asks", async () => {
    const tenant = await freshTenant();
    const before = await tenant.castcoOwner.get(portal(tenant.castco)).expect(200);
    expectDocumented(payoutAccountResponseSchema, before.body);
    expect(before.body).toEqual({ state: 'not_connected' });
    expect((await tenant.staff.get(staffPath(tenant.castco)).expect(200)).body).toEqual({ state: 'not_connected' });

    const first = await tenant.castcoOwner.post(`${portal(tenant.castco)}/link`).expect(200);

    expectDocumented(payoutLinkResponseSchema, first.body);
    expect(first.body).toEqual({ url: expect.any(String), expires_at: expect.any(String) });
    const account = await row(tenant);
    expect(account.state).toBe('onboarding');
    expect((await fake.getPartnerAccount({ secretKey: '' }, account.providerAccountId)).state).toBe('onboarding');
    const seen = await tenant.castcoOwner.get(portal(tenant.castco)).expect(200);
    expect(seen.body).toEqual({ state: 'onboarding' });
    // The partner never gets the provider's id from us; the link is the provider's own, and names it there.
    expect(JSON.stringify(seen.body)).not.toContain(account.providerAccountId);

    // Again, from the partner and from staff: a new link, on the same account.
    const second = await tenant.castcoOwner.post(`${portal(tenant.castco)}/link`).expect(200);
    const byStaff = await tenant.staff.post(`${staffPath(tenant.castco)}/link`).expect(200);
    expectDocumented(payoutLinkResponseSchema, byStaff.body);
    expect(new Set([first.body.url, second.body.url, byStaff.body.url]).size).toBe(3);
    expect((await row(tenant)).providerAccountId).toBe(account.providerAccountId);
    expect(await prisma.inTenant(tenant.id, (tx) => tx.partnerPayoutAccount.count())).toBe(1);
  });

  it('marks the account ready when the provider says so on the connect endpoint, and only there', async () => {
    const tenant = await freshTenant();
    await tenant.castcoOwner.post(`${portal(tenant.castco)}/link`).expect(200);
    const account = await row(tenant);
    fake.setPartnerAccountState(account.providerAccountId, 'ready');
    const sent = {
      id: `evt_${newId().replaceAll('-', '')}`,
      type: 'account.updated',
      objectId: account.providerAccountId,
      account: account.providerAccountId,
    };

    // Signed with the connect secret, it is not one of the payments endpoint's.
    const secrets = await app.get(PaymentAccountService).keysFor(tenant.id);
    const body = eventBody(sent);
    await postRaw(app, webhookPath(tenant.id, 'payments'), body, fake.sign(body, secrets.connectWebhookSecret)).expect(400);
    expect((await row(tenant)).state).toBe('onboarding');

    await sendEvent(app, tenant.id, sent, 'connect');

    expect((await tenant.castcoOwner.get(portal(tenant.castco)).expect(200)).body).toEqual({ state: 'ready' });
    const staffSeen = await tenant.staff.get(staffPath(tenant.castco)).expect(200);
    expectDocumented(payoutAccountResponseSchema, staffSeen.body);
    expect(staffSeen.body).toEqual({ state: 'ready' });
    const partner = await tenant.staff.get(`/partners/${tenant.castco}`).expect(200);
    expectDocumented(partnerResponseSchema, partner.body);
    expect(partner.body).toMatchObject({ payout_account: 'ready' });

    // Restricted later: the state follows the provider.
    fake.setPartnerAccountState(account.providerAccountId, 'restricted');
    await sendEvent(app, tenant.id, { ...sent, id: `evt_${newId().replaceAll('-', '')}` }, 'connect');
    expect((await row(tenant)).state).toBe('restricted');
  });

  it('ignores an update for an account that is not one of ours', async () => {
    const tenant = await freshTenant();
    await tenant.castcoOwner.post(`${portal(tenant.castco)}/link`).expect(200);
    const sent = { id: `evt_${newId().replaceAll('-', '')}`, type: 'account.updated', objectId: 'acct_not_ours', account: 'acct_not_ours' };

    await sendEvent(app, tenant.id, sent, 'connect');

    const stored = await prisma.inTenant(tenant.id, (tx) => tx.paymentEvent.findFirstOrThrow({ where: { providerEventId: sent.id } }));
    expect(stored).toMatchObject({ error: null, appliedAt: expect.any(Date) });
    expect((await row(tenant)).state).toBe('onboarding');
  });

  it("lets only the partner's owner and staff who manage partners ask for a link", async () => {
    const tenant = await freshTenant();

    await tenant.castcoMember.post(`${portal(tenant.castco)}/link`).expect(403);
    await tenant.metalworksOwner.post(`${portal(tenant.castco)}/link`).expect(404);
    await tenant.metalworksOwner.get(portal(tenant.castco)).expect(404);
    await tenant.staffMember.post(`${staffPath(tenant.castco)}/link`).expect(403);
    await tenant.staff.post(`${staffPath(newId())}/link`).expect(404);
    await tenant.staff.get(staffPath(newId())).expect(404);
    // Staff who read partners see the state.
    expect((await tenant.staffMember.get(staffPath(tenant.castco)).expect(200)).body).toEqual({ state: 'not_connected' });
    expect(await prisma.inTenant(tenant.id, (tx) => tx.partnerPayoutAccount.count())).toBe(0);
  });
});
