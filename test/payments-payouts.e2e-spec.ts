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
import { partnerOwedResponseSchema, portalOwedResponseSchema } from '../src/modules/partners/partner-response';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { LedgerService } from '../src/modules/payments/ledger.service';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { payoutPageResponseSchema, payoutResponseSchema } from '../src/modules/payments/payment-response';
import { PayoutReminderHandler } from '../src/modules/payments/payout-reminder.handler';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { sendEvent } from './payment-webhooks';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface OwedJob {
  assignment_id: string;
  group_id: string;
  state: 'not_yet' | 'owed';
  amount: string;
  paid: string;
  due: string;
  customer_paid?: boolean | null;
}
interface Owed {
  total: string;
  jobs: OwedJob[];
}
interface Payout {
  id: string;
  amount: string;
  status: string;
  failure: string | null;
  jobs: { group_id: string; amount: string }[];
}

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const d = (value: string) => new Prisma.Decimal(value);

/** The real jobs, with a tiny backoff so a retry happens within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'payments.event': { ...JOBS['payments.event'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

/**
 * Paying partners (Payments plan, Task 12): staff pay a partner what is due, owed less paid, in one
 * transfer to its ready payout account, never twice. A refused or reversed transfer makes the jobs
 * due again; a raised amount or a correction shows in the next payout.
 */
describe('payments: paying partners', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakePaymentProvider;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
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

  /**
   * The priced cast part; tax at 19 %; the workspace's payment keys; CastCo approved, with an owner and
   * a payout account that is ready. Two of CastCo's jobs are owed, every piece made: one straight
   * from a quote, the other Brightline's order line, paying later and not paid.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '19' }] }).expect(200);
    await staff.put('/payments/account', KEYS).expect(200);

    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;
    const castco = ((await staff.post('/partners', { name: 'CastCo', display_name: 'CastCo' }).expect(201)).body as { id: string }).id;
    await staff
      .put(`/partners/${castco}/capabilities`, {
        capabilities: [printPattern, castingTree, casting, polishing, finalQc, packing].map((step_type_id) => ({
          step_type_id,
          capacity: 200,
          capacity_period: 'week',
        })),
      })
      .expect(200);
    await staff.put(`/partners/${castco}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
    await staff.post(`/partners/${castco}/prices/copy-from-workspace`).expect(200);
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
    await staff.put(`/partners/${castco}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
    await staff.post(`/partners/${castco}/approve`).expect(200);
    const castcoOwner = await partnerPerson(tenant.id, castco, 'owner');

    // CastCo's payout account, made through a link and ready at the provider.
    await castcoOwner.post(`/partner-portal/partners/${castco}/payout-account/link`).expect(200);
    const account = await prisma.inTenant(tenant.id, (tx) => tx.partnerPayoutAccount.update({ where: { partnerId: castco }, data: { state: 'ready' } }));

    const brightline = ((await staff.post('/customers', { name: 'Brightline' }).expect(201)).body as { id: string }).id;
    await staff.put(`/customers/${brightline}/payment-terms`, { terms: 'pay_later' }).expect(200);
    const quote = async () =>
      ((
        await staff
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 10,
            file_version_id: cast.versionId,
            customer_id: brightline,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote.id;
    /** Offered to CastCo, accepted, and every piece made: owed. */
    const owedJob = async (group: string) => {
      const offered = await staff.post(`/partners/jobs/${group}/offer`, { partner_id: castco }).expect(201);
      await castcoOwner.post(`/partner-portal/partners/${castco}/jobs/${group}/accept`).expect(200);
      await prisma.inTenant(tenant.id, (tx) => tx.workOrder.updateMany({ where: { groupId: group }, data: { status: 'finished', currentStepId: null } }));
      return { group, cost: (offered.body as { cost: string }).cost };
    };
    const direct = await owedJob(((await staff.post('/workflow/groups', { quote_id: await quote() }).expect(201)).body as { id: string }).id);
    const order = (
      await staff
        .post('/orders', {
          customer_id: brightline,
          lines: [{ quote_id: await quote() }],
          address: { name: 'Brightline', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
          shipping_method: 'courier',
        })
        .expect(201)
    ).body as { lines: { group_id: string }[] };
    const fromOrder = await owedJob(order.lines[0].group_id);

    return {
      id: tenant.id,
      staff,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
      castco,
      castcoOwner,
      accountId: account.providerAccountId,
      direct,
      fromOrder,
      total: d(direct.cost).plus(fromOrder.cost).toFixed(2),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const owed = async (tenant: Tenant) => {
    const res = await tenant.staff.get(`/partners/${tenant.castco}/owed`).expect(200);
    expectDocumented(partnerOwedResponseSchema, res.body);
    return res.body as Owed;
  };
  const forJob = (all: Owed, group: string) => all.jobs.find((job) => job.group_id === group)!;
  const pay = (tenant: Tenant, by = tenant.staff) => by.post(`/partners/${tenant.castco}/payouts`);
  /** The payout, once the transfer job has settled it. */
  const settled = (tenant: Tenant, payoutId: string) =>
    waitFor(() =>
      prisma.inTenant(tenant.id, async (tx) => {
        const row = await tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
        return row.status === 'pending' ? undefined : row;
      }),
    );
  const raised = (tenant: Tenant, eventKey: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey } }));
  const partnerCosts = (tenant: Tenant) =>
    prisma.inTenant(tenant.id, (tx) => app.get(LedgerService).balance(tx, 'partner_costs', { partnerId: tenant.castco }));
  /** One of the job's pieces taken back before the payout step: the job is no longer owed. */
  const takeBack = (tenant: Tenant, group: string) =>
    prisma.inTenant(tenant.id, async (tx) => {
      const { workflowVersion } = await tx.workOrderGroup.findUniqueOrThrow({
        where: { id: group },
        select: { workflowVersion: { select: { steps: { orderBy: { position: 'asc' }, take: 1, select: { id: true } } } } },
      });
      const piece = await tx.workOrder.findFirstOrThrow({ where: { groupId: group } });
      await tx.workOrder.update({ where: { id: piece.id }, data: { status: 'active', currentStepId: workflowVersion.steps[0].id } });
    });

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
    // The worker makes the transfers and applies the webhooks with its own provider instance, which sees what the app's saw.
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('pays CastCo what is due in one transfer, journals it, and shows it to both sides', async () => {
    const tenant = await freshTenant();

    // What is due, and whether the customer has paid: staff only.
    const before = await owed(tenant);
    expect(forJob(before, tenant.fromOrder.group)).toMatchObject({ state: 'owed', paid: '0.00', due: tenant.fromOrder.cost, customer_paid: false });
    expect(forJob(before, tenant.direct.group)).toMatchObject({ paid: '0.00', due: tenant.direct.cost, customer_paid: null });
    const portalOwed = await tenant.castcoOwner.get(`/partner-portal/partners/${tenant.castco}/owed`).expect(200);
    expectDocumented(portalOwedResponseSchema, portalOwed.body);
    expect((portalOwed.body as Owed).jobs.every((job) => !('customer_paid' in job) && job.due !== undefined)).toBe(true);

    const res = await pay(tenant).expect(202);

    expectDocumented(payoutResponseSchema, res.body);
    expect(res.body).toMatchObject({ status: 'pending', amount: tenant.total });
    const payout = await settled(tenant, (res.body as Payout).id);
    expect(payout).toMatchObject({ status: 'paid', providerTransferId: expect.any(String), failure: null, settledAt: expect.any(Date) });
    expect(fake.transfersTo(tenant.accountId).map((transfer) => transfer.amount.toFixed(2))).toEqual([tenant.total]);

    const journal = await prisma.inTenant(tenant.id, (tx) => tx.ledgerJournal.findFirstOrThrow({ where: { kind: 'payout' }, include: { lines: true } }));
    expect(journal.lines.reduce((sum, line) => sum.plus(line.amount), d('0')).toFixed(2)).toBe('0.00');
    expect((await partnerCosts(tenant)).toFixed(2)).toBe(tenant.total);
    // The partner is told once the payout has committed.
    await waitFor(async () => ((await raised(tenant, 'payout.paid')) === 1 ? true : undefined));

    // Both sides see it, with its jobs; the partner never sees the order behind them.
    const mine = await tenant.castcoOwner.get(`/partner-portal/partners/${tenant.castco}/payouts`).expect(200);
    expectDocumented(payoutPageResponseSchema, mine.body);
    const seen = (mine.body as { data: Payout[] }).data;
    expect(seen).toEqual([expect.objectContaining({ status: 'paid', amount: tenant.total })]);
    expect(seen[0].jobs.map((job) => job.group_id).sort()).toEqual([tenant.direct.group, tenant.fromOrder.group].sort());
    expect(mine.text).not.toContain('Brightline');
    const staffSeen = await tenant.staff.get(`/partners/${tenant.castco}/payouts`).expect(200);
    expectDocumented(payoutPageResponseSchema, staffSeen.body);
    expect(await tenant.member.get(`/partners/${tenant.castco}/payouts`).expect(200)).toBeTruthy();

    // Paid: nothing is due, and nothing is paid twice.
    const after = await owed(tenant);
    expect(forJob(after, tenant.direct.group)).toMatchObject({ paid: tenant.direct.cost, due: '0.00' });
    await pay(tenant).expect(409);
    expect(fake.transfersTo(tenant.accountId)).toHaveLength(1);
  });

  it('pays once when Pay is pressed twice at once, or repeated with the same key (Review Focus 3)', async () => {
    const tenant = await freshTenant();

    const results = await Promise.all([pay(tenant), pay(tenant)]);

    expect(results.map((res) => res.status).sort()).toEqual([202, 409]);
    const accepted = results.find((res) => res.status === 202)!;
    await settled(tenant, (accepted.body as Payout).id);
    expect(fake.transfersTo(tenant.accountId)).toHaveLength(1);

    // The same request again with its key answers what it answered, and makes nothing new.
    const key = `pay-${newId()}`;
    const other = await freshTenant();
    const first = await other.staff.post(`/partners/${other.castco}/payouts`).set('Idempotency-Key', key).expect(202);
    const again = await other.staff.post(`/partners/${other.castco}/payouts`).set('Idempotency-Key', key).expect(202);
    expect((again.body as Payout).id).toBe((first.body as Payout).id);
    expect(await prisma.inTenant(other.id, (tx) => tx.payout.count())).toBe(1);
  });

  it('makes the jobs due again when the provider refuses the transfer, and the next Pay pays them', async () => {
    const tenant = await freshTenant();
    fake.failNextTransfer('Insufficient funds in the platform balance');

    const failed = await settled(tenant, ((await pay(tenant).expect(202)).body as Payout).id);

    expect(failed).toMatchObject({ status: 'failed', failure: 'Insufficient funds in the platform balance', providerTransferId: null });
    await waitFor(async () => ((await raised(tenant, 'payout.failed')) === 1 ? true : undefined));
    expect(forJob(await owed(tenant), tenant.direct.group)).toMatchObject({ paid: '0.00', due: tenant.direct.cost });
    expect((await partnerCosts(tenant)).toFixed(2)).toBe('0.00');

    const retried = await settled(tenant, ((await pay(tenant).expect(202)).body as Payout).id);
    expect(retried).toMatchObject({ status: 'paid' });
    expect(retried.amount.toFixed(2)).toBe(tenant.total);
    expect(fake.transfersTo(tenant.accountId)).toHaveLength(1);
  });

  it('pays the rest when staff raise what a job is owed, and takes back a job no longer owed', async () => {
    const tenant = await freshTenant();
    await settled(tenant, ((await pay(tenant).expect(202)).body as Payout).id);

    // Raised by 50 after it was paid: 50 is due.
    const raisedTo = d(tenant.direct.cost).plus('50.00').toFixed(2);
    await tenant.staff
      .put(`/partners/jobs/${tenant.direct.group}/owed`, { partner_id: tenant.castco, amount: raisedTo, reason: 'Rush surcharge' })
      .expect(200);
    expect(forJob(await owed(tenant), tenant.direct.group)).toMatchObject({ amount: raisedTo, paid: tenant.direct.cost, due: '50.00' });
    const fifty = await settled(tenant, ((await pay(tenant).expect(202)).body as Payout).id);
    expect(fifty.amount.toFixed(2)).toBe('50.00');

    // A correction takes Brightline's job back before the payout step: what was paid for it comes off the next payout.
    await takeBack(tenant, tenant.fromOrder.group);
    expect(forJob(await owed(tenant), tenant.fromOrder.group)).toMatchObject({ state: 'not_yet', due: d(tenant.fromOrder.cost).neg().toFixed(2) });
    await pay(tenant).expect(409);
    const moreForDirect = d(raisedTo).plus(tenant.fromOrder.cost).plus('10.00').toFixed(2);
    await tenant.staff
      .put(`/partners/jobs/${tenant.direct.group}/owed`, { partner_id: tenant.castco, amount: moreForDirect, reason: 'Extra finishing' })
      .expect(200);

    const net = await pay(tenant).expect(202);
    expect((net.body as Payout).amount).toBe('10.00');
    expect((net.body as Payout).jobs.map((job) => [job.group_id, job.amount]).sort()).toEqual(
      [
        [tenant.direct.group, d(tenant.fromOrder.cost).plus('10.00').toFixed(2)],
        [tenant.fromOrder.group, d(tenant.fromOrder.cost).neg().toFixed(2)],
      ].sort(),
    );
    await settled(tenant, (net.body as Payout).id);
    expect(fake.transfersTo(tenant.accountId).map((transfer) => transfer.amount.toFixed(2))).toEqual([tenant.total, '50.00', '10.00']);
  });

  it('reverses a payout whose transfer the provider reverses, and the jobs are due again', async () => {
    const tenant = await freshTenant();
    const payout = await settled(tenant, ((await pay(tenant).expect(202)).body as Payout).id);
    const sent = { id: `evt_${newId().replaceAll('-', '')}`, type: 'transfer.reversed', objectId: payout.providerTransferId!, account: tenant.accountId };

    await sendEvent(app, tenant.id, sent, 'connect');

    expect((await prisma.inTenant(tenant.id, (tx) => tx.payout.findUniqueOrThrow({ where: { id: payout.id } }))).status).toBe('reversed');
    expect(await prisma.inTenant(tenant.id, (tx) => tx.ledgerJournal.count({ where: { kind: 'reversal' } }))).toBe(1);
    expect((await partnerCosts(tenant)).toFixed(2)).toBe('0.00');
    expect(forJob(await owed(tenant), tenant.direct.group)).toMatchObject({ paid: '0.00', due: tenant.direct.cost });
    expect(await raised(tenant, 'payout.failed')).toBe(1);

    // Told again: nothing more.
    await sendEvent(app, tenant.id, { ...sent, id: `evt_${newId().replaceAll('-', '')}` }, 'connect');
    expect(await prisma.inTenant(tenant.id, (tx) => tx.ledgerJournal.count({ where: { kind: 'reversal' } }))).toBe(1);
  });

  it('refuses a partner without a ready account, and staff who may not pay', async () => {
    const tenant = await freshTenant();

    await pay(tenant, tenant.member).expect(403);
    await tenant.castcoOwner.post(`/partners/${tenant.castco}/payouts`).expect(403);
    await prisma.inTenant(tenant.id, (tx) => tx.partnerPayoutAccount.update({ where: { partnerId: tenant.castco }, data: { state: 'restricted' } }));
    const refused = await pay(tenant).expect(409);
    expect(JSON.stringify(refused.body)).toContain('no ready payout account');
    await tenant.staff.post(`/partners/${newId()}/payouts`).expect(404);
    expect(await prisma.inTenant(tenant.id, (tx) => tx.payout.count())).toBe(0);
  });

  it("reminds staff who pay of each partner's due total, and whether it can be paid", async () => {
    const tenant = await freshTenant();

    await app.get(PayoutReminderHandler).handle();

    const reminders = await prisma.inTenant(tenant.id, (tx) => tx.notification.findMany({ where: { eventKey: 'payouts.reminder' } }));
    expect(reminders).toHaveLength(1);
    const text = JSON.stringify(reminders[0].payload);
    expect(text).toContain('CastCo');
    expect(text).toContain(tenant.total);
  });
});
