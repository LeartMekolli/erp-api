import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { orderResponseSchema } from '../src/modules/orders/order-response';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { receivedJournal } from '../src/modules/payments/ledger';
import { LedgerService } from '../src/modules/payments/ledger.service';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface Order {
  id: string;
  number: number;
  lines: { group_id: string }[];
  payment: { invoice: { status: string; credited: string } | null };
}
interface Claim {
  id: string;
  lines: { id: string }[];
}

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const ADDRESS = { name: 'Brightline', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
const d = (value: string) => new Prisma.Decimal(value);

/**
 * Orders 3a, Task 3: a refund on a claim gives back what was paid, and credits the rest on the order's
 * open invoice at the provider, so the customer never pays first to be paid back (O3-11). The credit note
 * is asked for after the commit, and journalled once issued.
 */
describe('claims: credit notes on open invoices', () => {
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

  /** The priced cast part; tax at 19 %; the workspace's payment keys; Brightline paying later within 30 days. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '19' }] }).expect(200);
    await staff.put('/payments/account', KEYS).expect(200);
    const brightline = ((await staff.post('/customers', { name: 'Brightline' }).expect(201)).body as { id: string }).id;
    await staff.put(`/customers/${brightline}/payment-terms`, { terms: 'pay_later', days_to_pay: 30 }).expect(200);

    /** Brightline's order of 2 pieces, made in-house, shipped and invoiced, delivered, and unpaid. */
    const delivered = async () => {
      const quote = ((
        await staff
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 2,
            file_version_id: cast.versionId,
            customer_id: brightline,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote.id;
      const order = (
        await staff.post('/orders', { customer_id: brightline, lines: [{ quote_id: quote }], address: ADDRESS, shipping_method: 'courier' }).expect(201)
      ).body as Order;
      await prisma.inTenant(tenant.id, (tx) =>
        tx.workOrder.updateMany({ where: { groupId: order.lines[0].group_id }, data: { status: 'finished', currentStepId: null } }),
      );
      await staff.post(`/orders/${order.id}/ship`, {}).expect(200);
      const invoice = await waitFor(() =>
        prisma.inTenant(tenant.id, async (tx) => {
          const row = await tx.invoice.findFirst({ where: { orderId: order.id, status: 'open' } });
          return row ? { ...row, providerInvoiceId: row.providerInvoiceId! } : undefined;
        }),
      );
      await staff.post(`/orders/${order.id}/deliver`).expect(200);
      return { order, invoice };
    };
    /** Staff claim both pieces as damaged in transit. */
    const claim = async (order: Order) =>
      (
        await staff
          .post(`/orders/${order.id}/claims`, { reason: 'damaged_in_transit', description: 'Crushed parcel.', lines: [{ position: 0, pieces: 2 }] })
          .expect(201)
      ).body as Claim;
    const refund = (claimed: Claim, amount: string) =>
      staff.post(`/claims/${claimed.id}/lines/${claimed.lines[0].id}/decision`, { fault: 'courier', outcome: 'refund', refund_amount: amount });

    return { id: tenant.id, staff, brightline, delivered, claim, refund };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  /** The order's credit notes, once none is pending any more. */
  const issued = (w: Workspace, orderId: string) =>
    waitFor(async () => {
      const rows = await prisma.inTenant(w.id, (tx) => tx.creditNote.findMany({ where: { orderId }, orderBy: { id: 'asc' } }));
      return rows.length > 0 && rows.every((row) => row.status !== 'pending') ? rows : undefined;
    });
  const journalsOf = (w: Workspace, orderId: string, kind: string) =>
    prisma.inTenant(w.id, (tx) => tx.ledgerJournal.findMany({ where: { orderId, kind }, include: { lines: true } }));
  const receivable = (lines: { account: string; amount: Prisma.Decimal }[]) =>
    lines.filter((line) => line.account === 'customer_receivable').reduce((sum, line) => sum.add(line.amount), d('0')).toFixed(2);

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    fake = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
    // The worker issues the credit notes with its own provider instance, which sees what the app's saw.
    worker = await startTestWorker();
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('credits an open invoice instead of refunding', async () => {
    const w = await workspace();
    const { order, invoice } = await w.delivered();
    const claimed = await w.claim(order);

    await w.refund(claimed, '10.00').expect(200);

    const [note] = await issued(w, order.id);
    expect([note.amount.toFixed(2), note.status, note.invoiceId, note.claimLineId]).toEqual(['10.00', 'issued', invoice.id, claimed.lines[0].id]);
    expect(note.providerCreditNoteId).toEqual(expect.any(String));
    // At the provider, the invoice is due 10.00 less; nothing was refunded.
    expect(fake.invoiceCredited(invoice.providerInvoiceId).toFixed(2)).toBe('10.00');
    expect(await prisma.inTenant(w.id, (tx) => tx.refund.count({ where: { orderId: order.id } }))).toBe(0);

    // The ledger takes 10.00 off what Brightline owes.
    const journals = await journalsOf(w, order.id, 'credit_note');
    expect(journals).toHaveLength(1);
    expect(receivable(journals[0].lines)).toBe('-10.00');

    // Staff see the invoice was credited, still open.
    const read = await w.staff.get(`/orders/${order.id}`).expect(200);
    expectDocumented(orderResponseSchema, read.body);
    expect((read.body as Order).payment.invoice).toMatchObject({ status: 'open', credited: '10.00' });
  });

  it('refunds what was paid and credits the rest (Review Focus 2)', async () => {
    const w = await workspace();
    const { order, invoice } = await w.delivered();
    // Brightline paid 4.00 of the invoice by bank transfer: a part payment the ledger holds.
    await prisma.inTenant(w.id, (tx) =>
      app.get(LedgerService).post(tx, {
        ...receivedJournal(w.brightline, d('4.00'), 'outside_stripe'),
        occurredAt: new Date(),
        currency: 'EUR',
        orderId: order.id,
        customerId: w.brightline,
        memo: 'Part payment by bank transfer',
      }),
    );
    const claimed = await w.claim(order);

    await w.refund(claimed, '10.00').expect(200);

    // What was paid is refunded, the rest credited: together, the 10.00 decided.
    const refunds = await prisma.inTenant(w.id, (tx) => tx.refund.findMany({ where: { orderId: order.id } }));
    expect(refunds.map((row) => [row.amount.toFixed(2), row.kind, row.status])).toEqual([['4.00', 'outside', 'succeeded']]);
    const [note] = await issued(w, order.id);
    expect([note.amount.toFixed(2), note.status]).toEqual(['6.00', 'issued']);
    expect(fake.invoiceCredited(invoice.providerInvoiceId).toFixed(2)).toBe('6.00');
    expect(refunds[0].amount.add(note.amount).toFixed(2)).toBe('10.00');

    // The ledger: the 4.00 back out of the bank, the 6.00 off what is owed.
    expect(receivable((await journalsOf(w, order.id, 'credit_note'))[0].lines)).toBe('-6.00');
    // What is still open on the invoice: its total less the part paid and the credit.
    const read = (await w.staff.get(`/orders/${order.id}`).expect(200)).body as Order;
    expect(read.payment.invoice).toMatchObject({ status: 'open', credited: '6.00' });
    expect(invoice.total.sub('4.00').sub('6.00').gt(0)).toBe(true);
  });
});
