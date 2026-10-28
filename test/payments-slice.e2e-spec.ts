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
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { UnpaidOrdersHandler } from '../src/modules/payments/unpaid-orders.handler';
import { measuredDesign } from './catalog-fixtures';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { eventBody, postRaw, sendEvent, webhookPath } from './payment-webhooks';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface Order {
  id: string;
  state: string;
  total: string;
  lines: { group_id: string }[];
  payment: { state: string; paid: string; refunded: string; pay_url: string | null; held_for_credit: boolean };
}
interface OwedJob {
  group_id: string;
  state: string;
  due: string;
  customer_paid: boolean | null;
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
 * The payments slice (Payments spec, "Done when" 2–10), in one workspace with the fake provider:
 * paying first, the unpaid cancel, replayed and forged webhooks, paying later with an invoice and the
 * credit limit, a partner's onboarding and payout with a refused transfer, both refunds, and a ledger
 * that never changes and always balances.
 */
describe('payments: the money flow, end to end', () => {
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

  async function person(tenantId: string, kind: 'customer' | 'partner', organisationId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: kind, organisationId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

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
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('takes money in, pays partners and gives money back, every step journalled and balanced', async () => {
    // --- The workspace: the cast part, CastCo taking direct orders, Anna paying first, Brightline later.
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '19' }] }).expect(200);
    // Done when 1: the workspace's test keys.
    await staff.put('/payments/account', KEYS).expect(200);

    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;
    const castco = ((await staff.post('/partners', { name: 'CastCo', display_name: 'CastCo' }).expect(201)).body as { id: string }).id;
    await staff
      .put(`/partners/${castco}/capabilities`, {
        capabilities: [printPattern, castingTree, casting, polishing, finalQc, packing].map((step_type_id) => ({
          step_type_id,
          capacity: 500,
          capacity_period: 'week',
        })),
      })
      .expect(200);
    await staff.put(`/partners/${castco}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
    await staff.post(`/partners/${castco}/prices/copy-from-workspace`).expect(200);
    await staff.patch(`/partners/${castco}/limits`, { accepts_direct_orders: true }).expect(200);
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
    await staff.put(`/partners/${castco}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
    await staff.post(`/partners/${castco}/approve`).expect(200);
    const castcoOwner = await person(tenant.id, 'partner', castco, 'owner');

    const anna = ((await staff.post('/customers', { name: 'Anna Studio' }).expect(201)).body as { id: string }).id;
    await staff.patch(`/customers/${anna}`, { may_pick_partner: true }).expect(200);
    const design = (await measuredDesign(prisma, tenant.id, owner.id, { customerId: anna })).versionId;
    const buyer = await person(tenant.id, 'customer', anna, 'buyer');
    const brightline = ((await staff.post('/customers', { name: 'Brightline' }).expect(201)).body as { id: string }).id;
    await staff.put(`/customers/${brightline}/payment-terms`, { terms: 'pay_later', days_to_pay: 30, credit_limit: '5000.00' }).expect(200);

    const address = { name: 'Customer', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
    const view = async (orderId: string) => (await staff.get(`/orders/${orderId}`).expect(200)).body as Order;
    /** Anna orders at CastCo: it waits for payment, holding the job. */
    const annaOrders = async () => {
      const quote = ((
        await buyer
          .post(`/portal/customers/${anna}/quotes`, {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 10,
            file_version_id: design,
            partner_id: castco,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote.id;
      const placed = await buyer.post(`/portal/customers/${anna}/orders`, { lines: [{ quote_id: quote }], address, shipping_method: 'courier' }).expect(201);
      // As staff see it, with its jobs.
      return view((placed.body as { id: string }).id);
    };
    /** Staff order for Brightline, made in-house. */
    const brightlineOrders = async () => {
      const quote = ((
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
      return (await staff.post('/orders', { customer_id: brightline, lines: [{ quote_id: quote }], address, shipping_method: 'courier' }).expect(201))
        .body as Order;
    };
    const event = (type: string, objectId: string, account?: string) => ({
      id: `evt_${newId().replaceAll('-', '')}`,
      type,
      objectId,
      ...(account ? { account } : {}),
    });
    const openCheckout = (orderId: string) =>
      prisma.inTenant(tenant.id, (tx) => tx.orderPayment.findFirstOrThrow({ where: { orderId, status: 'open' } }));
    const payByCard = async (orderId: string) => {
      const checkout = await openCheckout(orderId);
      fake.completeCheckout(checkout.providerCheckoutId!);
      const sent = event('checkout.session.completed', checkout.providerCheckoutId!);
      await sendEvent(app, tenant.id, sent);
      return sent;
    };
    const finish = (group: string) =>
      prisma.inTenant(tenant.id, (tx) => tx.workOrder.updateMany({ where: { groupId: group }, data: { status: 'finished', currentStepId: null } }));
    const journalCount = () => prisma.inTenant(tenant.id, (tx) => tx.ledgerJournal.count());
    const raised = (eventKey: string) => prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey } }));

    // --- Done when 2: Anna pays first; the order starts once paid, billed, paid and the fee journalled.
    const paidFirst = await annaOrders();
    expect(paidFirst).toMatchObject({ state: 'awaiting_payment', payment: { state: 'awaiting_payment', pay_url: expect.any(String) } });
    const paidEvent = await payByCard(paidFirst.id);
    expect(await view(paidFirst.id)).toMatchObject({ state: 'in_production', payment: { state: 'paid', paid: paidFirst.total } });
    const kinds = await prisma.inTenant(tenant.id, (tx) => tx.ledgerJournal.findMany({ where: { orderId: paidFirst.id }, orderBy: { id: 'asc' } }));
    expect(kinds.map((journal) => journal.kind)).toEqual(['order_billed', 'payment_received', 'provider_fee']);

    // --- Done when 3: an order not paid in time is cancelled, and Anna is told.
    const unpaid = await annaOrders();
    await prisma.inTenant(tenant.id, (tx) => tx.order.update({ where: { id: unpaid.id }, data: { payBy: new Date(Date.now() - 60_000) } }));
    await app.get(UnpaidOrdersHandler).handle();
    expect((await view(unpaid.id)).state).toBe('cancelled');
    expect(await raised('order.unpaid_cancelled')).toBe(1);

    // --- Done when 4: a replayed webhook changes nothing; a forged one is refused.
    const before = await journalCount();
    await sendEvent(app, tenant.id, { ...paidEvent, id: `evt_${newId().replaceAll('-', '')}` });
    expect(await journalCount()).toBe(before);
    const forged = eventBody(event('checkout.session.completed', 'cs_forged'));
    await postRaw(app, webhookPath(tenant.id), forged, fake.sign(forged, 'whsec_not_the_secret')).expect(400);

    // --- Done when 5: Brightline's order starts at once, is invoiced when shipped and paid by card.
    const invoicedOrder = await brightlineOrders();
    expect(invoicedOrder).toMatchObject({ state: 'in_production', payment: { state: 'not_billed' } });
    await finish(invoicedOrder.lines[0].group_id);
    await staff.post(`/orders/${invoicedOrder.id}/ship`, {}).expect(200);
    const invoice = await waitFor(() =>
      prisma.inTenant(tenant.id, async (tx) => (await tx.invoice.findFirst({ where: { orderId: invoicedOrder.id, status: 'open' } })) ?? undefined),
    );
    fake.payInvoice(invoice.providerInvoiceId!);
    await sendEvent(app, tenant.id, event('invoice.paid', invoice.providerInvoiceId!));
    expect((await view(invoicedOrder.id)).payment).toMatchObject({ state: 'paid', paid: invoicedOrder.total });

    // Past the limit, orders wait for payment; staff release one by hand.
    await staff.put(`/customers/${brightline}/payment-terms`, { terms: 'pay_later', days_to_pay: 30, credit_limit: '1.00' }).expect(200);
    const held = await brightlineOrders();
    expect(held.payment).toMatchObject({ state: 'awaiting_payment', held_for_credit: true });
    const released = (await staff.post(`/orders/${held.id}/release`, { reason: 'Long-standing customer' }).expect(200)).body as Order;
    expect(released).toMatchObject({ state: 'in_production', payment: { state: 'not_billed' } });

    // --- Done when 7: CastCo connects its payout account, and it becomes ready.
    await castcoOwner.post(`/partner-portal/partners/${castco}/payout-account/link`).expect(200);
    const account = await prisma.inTenant(tenant.id, (tx) => tx.partnerPayoutAccount.findUniqueOrThrow({ where: { partnerId: castco } }));
    fake.setPartnerAccountState(account.providerAccountId, 'ready');
    await sendEvent(app, tenant.id, event('account.updated', account.providerAccountId, account.providerAccountId), 'connect');
    expect((await castcoOwner.get(`/partner-portal/partners/${castco}/payout-account`).expect(200)).body).toEqual({ state: 'ready' });

    // --- Done when 8 and 9: CastCo is owed Anna's job and Brightline's, which Brightline has not paid.
    await finish(paidFirst.lines[0].group_id);
    const brightlineJob = released.lines[0].group_id;
    await staff.post(`/partners/jobs/${brightlineJob}/offer`, { partner_id: castco }).expect(201);
    await castcoOwner.post(`/partner-portal/partners/${castco}/jobs/${brightlineJob}/accept`).expect(200);
    await finish(brightlineJob);
    const owed = ((await staff.get(`/partners/${castco}/owed`).expect(200)).body as { jobs: OwedJob[] }).jobs;
    expect(owed.find((job) => job.group_id === brightlineJob)).toMatchObject({ state: 'owed', customer_paid: false });
    expect(owed.find((job) => job.group_id === paidFirst.lines[0].group_id)).toMatchObject({ state: 'owed', customer_paid: true });
    const due = owed.reduce((sum, job) => sum.plus(job.due), d('0')).toFixed(2);

    // A refused transfer leaves the jobs owed and tells staff; the next Pay pays both in one transfer.
    fake.failNextTransfer('Insufficient funds in the test balance');
    const refused = (await staff.post(`/partners/${castco}/payouts`).expect(202)).body as { id: string };
    await waitFor(() => prisma.inTenant(tenant.id, async (tx) => ((await tx.payout.findUniqueOrThrow({ where: { id: refused.id } })).status === 'failed' ? true : undefined)));
    // Staff are told once the failure has committed.
    await waitFor(async () => ((await raised('payout.failed')) === 1 ? true : undefined));
    const payout = (await staff.post(`/partners/${castco}/payouts`).expect(202)).body as { id: string; amount: string };
    expect(payout.amount).toBe(due);
    await waitFor(() => prisma.inTenant(tenant.id, async (tx) => ((await tx.payout.findUniqueOrThrow({ where: { id: payout.id } })).status === 'paid' ? true : undefined)));
    expect(fake.transfersTo(account.providerAccountId).map((transfer) => transfer.amount.toFixed(2))).toEqual([due]);
    await staff.post(`/partners/${castco}/payouts`).expect(409);
    const seen = (await castcoOwner.get(`/partner-portal/partners/${castco}/payouts`).expect(200)).body as { data: { status: string; jobs: object[] }[] };
    expect(seen.data.find((one) => one.status === 'paid')!.jobs).toHaveLength(2);

    // --- Done when 6: Anna cancels a paid order before any move, refunded in full.
    const annaCancels = await annaOrders();
    await payByCard(annaCancels.id);
    await buyer.post(`/portal/customers/${anna}/orders/${annaCancels.id}/cancel`, { reason: 'Changed my mind' }).expect(200);
    await waitFor(async () => ((await view(annaCancels.id)).payment.state === 'refunded' ? true : undefined));

    // Staff cancel a paid order whose partner has done some of it: the suggestion is the price less what it is owed.
    const staffCancels = await annaOrders();
    await payByCard(staffCancels.id);
    const group = staffCancels.lines[0].group_id;
    await staff.put(`/partners/jobs/${group}/owed`, { partner_id: castco, amount: '20.00', reason: 'Half the patterns printed' }).expect(200);
    await finish(group);
    const suggestion = (await staff.get(`/orders/${staffCancels.id}/refund-suggestion`).expect(200)).body as { suggested: string; work_done: string };
    expect(suggestion).toMatchObject({ suggested: d(staffCancels.total).minus('20.00').toFixed(2), work_done: '20.00' });
    const decided = d(suggestion.suggested).minus('5.00').toFixed(2);
    await staff
      .post(`/orders/${staffCancels.id}/cancel`, {
        reason: 'Customer withdrew',
        partner_owed: [{ position: 0, amount: '20.00', reason: 'Half the patterns printed' }],
        refund: { amount: decided },
      })
      .expect(200);
    await waitFor(async () => ((await view(staffCancels.id)).payment.state === 'partly_refunded' ? true : undefined));
    expect((await view(staffCancels.id)).payment.refunded).toBe(decided);

    // --- Done when 10: no journal can be changed or deleted, and every one, and the whole ledger, sums to zero.
    // The application's role may not even try (ADR 0003); the append-only trigger behind it is append-only.e2e-spec's.
    await expect(prisma.inTenant(tenant.id, (tx) => tx.$executeRaw`UPDATE ledger_line SET amount = amount`)).rejects.toThrow(/permission denied/i);
    await expect(prisma.inTenant(tenant.id, (tx) => tx.$executeRaw`DELETE FROM ledger_journal`)).rejects.toThrow(/permission denied/i);
    const journals = await prisma.inTenant(tenant.id, (tx) => tx.ledgerJournal.findMany({ include: { lines: true } }));
    expect(journals.length).toBeGreaterThan(10);
    for (const journal of journals) {
      expect([journal.kind, journal.lines.reduce((sum, line) => sum.plus(line.amount), d('0')).toFixed(2)]).toEqual([journal.kind, '0.00']);
    }
    const whole = await prisma.inTenant(tenant.id, (tx) => tx.ledgerLine.aggregate({ _sum: { amount: true } }));
    expect((whole._sum.amount ?? d('0')).toFixed(2)).toBe('0.00');
  });
});
