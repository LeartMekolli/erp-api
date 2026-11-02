import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { ScheduledExportsService } from '../src/modules/reporting/exports/scheduled-exports.service';
import { measuredDesign } from './catalog-fixtures';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface Order {
  id: string;
  number: number;
  total: string;
  lines: { id: string; total: string; group_id: string }[];
  payment: { invoice: { status: string; credited: string } | null };
}
interface Claim {
  id: string;
  state: string;
  lines: { id: string; decision: { outcome: string; customer_reason: string | null; remake_group_id: string | null } | null }[];
}
interface Decided extends Claim {
  remake: { group_id: string; unassigned_reasons: string[] } | null;
}
interface OwedJob {
  group_id: string;
  amount: string;
}

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const ADDRESS = { name: 'Studio', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
const d = (value: string) => new Prisma.Decimal(value);
const today = () => new Date().toISOString().slice(0, 10);

/** A CSV's lines as cells, without the BOM. None of this test's values hold a comma. */
function parse(bytes: Buffer): string[][] {
  return bytes
    .subarray(3)
    .toString('utf8')
    .split('\r\n')
    .filter((line) => line !== '')
    .map((line) => line.split(','));
}

/**
 * Orders 3a in one workspace (Orders 3 spec, "Done when" 1–3): a claim remade by the workshop at fault and,
 * declined, by another, with the first owed that much less; a partial refund on a paid order, a credit note
 * on an unpaid one and a refusal; and on the 1st, the accountant's files and the top customers, each told
 * to whoever is to hear of them.
 */
describe('Orders 3a: claims, remakes and scheduled reports', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let fake: FakePaymentProvider;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });
  type Client = ReturnType<typeof as>;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    fake = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
    worker = await startTestWorker();
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  async function person(tenantId: string, kind: 'customer' | 'partner', organisationId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: kind, organisationId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  it('claims end in a remake, a refund, a credit note or a refusal, and the 1st brings the reports', async () => {
    // The workspace: tax at 19 %, payment keys, an owner and an accountant; CastCo and MetalWorks able to
    // make the cast line; Luna Jewels paying first, with a buyer; Brightline paying later.
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const accountantUser = await createTestUser(prisma, tenant.id, { roles: ['accountant'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const accountant = as((await tokens.issueForUser(tenant.id, accountantUser.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '19' }] }).expect(200);
    await staff.put('/payments/account', KEYS).expect(200);

    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;
    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;
    const workshop = async (name: string) => {
      const id = ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
      await staff
        .put(`/partners/${id}/capabilities`, {
          capabilities: [printPattern, castingTree, casting, polishing, finalQc, packing].map((step_type_id) => ({ step_type_id, capacity: 200, capacity_period: 'week' })),
        })
        .expect(200);
      await staff.put(`/partners/${id}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
      await staff.post(`/partners/${id}/prices/copy-from-workspace`).expect(200);
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return { id, person: await person(tenant.id, 'partner', id, 'member') };
    };
    const castco = await workshop('CastCo');
    const metalworks = await workshop('MetalWorks');

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const buyer = await person(tenant.id, 'customer', luna, 'buyer');
    const brightline = ((await staff.post('/customers', { name: 'Brightline' }).expect(201)).body as { id: string }).id;
    await staff.put(`/customers/${brightline}/payment-terms`, { terms: 'pay_later', days_to_pay: 30 }).expect(200);

    /** An order of `quantity` pieces: Luna's paid by bank transfer, Brightline's invoiced; made by `maker` or in-house; delivered. */
    const delivered = async (customerId: string, quantity: number, maker?: { id: string; person: Client }) => {
      const quote = ((
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
      ).body as { quote: { id: string } }).quote.id;
      const order = (await staff.post('/orders', { customer_id: customerId, lines: [{ quote_id: quote }], address: ADDRESS, shipping_method: 'courier' }).expect(201))
        .body as Order;
      if (customerId === luna) {
        await staff.post(`/orders/${order.id}/paid-by-hand`, { reference: `Transfer ${order.number}`, received_on: today() }).expect(200);
      }
      const group = order.lines[0].group_id;
      if (maker) {
        await staff.post(`/partners/jobs/${group}/offer`, { partner_id: maker.id }).expect(201);
        await maker.person.post(`/partner-portal/partners/${maker.id}/jobs/${group}/accept`).expect(200);
      }
      await prisma.inTenant(tenant.id, (tx) => tx.workOrder.updateMany({ where: { groupId: group }, data: { status: 'finished', currentStepId: null } }));
      await staff.post(`/orders/${order.id}/ship`, { courier: 'DHL', tracking: 'JD0001' }).expect(200);
      if (customerId === brightline) {
        await waitFor(() => prisma.inTenant(tenant.id, async (tx) => (await tx.invoice.findFirst({ where: { orderId: order.id, status: 'open' } })) ?? undefined));
      }
      await staff.post(`/orders/${order.id}/deliver`).expect(200);
      return order;
    };
    const decide = (claim: Claim, body: object) => staff.post(`/claims/${claim.id}/lines/${claim.lines[0].id}/decision`, body).expect(200);
    const owedFor = async (partnerId: string, group: string) =>
      ((await staff.get(`/partners/${partnerId}/owed`).expect(200)).body as { jobs: OwedJob[] }).jobs.find((job) => job.group_id === group)!;
    const portalClaim = async (id: string) => (await buyer.get(`/portal/customers/${luna}/claims/${id}`).expect(200)).body as Claim;

    // 1. Luna's buyer claims two faulty pieces of a delivered order, with a photo.
    const rings = await delivered(luna, 10, castco);
    const photo = (await measuredDesign(prisma, tenant.id, owner.id, { measures: [], customerId: luna })).versionId;
    const faulty = (
      await buyer
        .post(`/portal/customers/${luna}/orders/${rings.id}/claims`, {
          reason: 'defect',
          description: 'Two rings have porous shanks.',
          lines: [{ position: 0, pieces: 2 }],
          photo_file_version_ids: [photo],
        })
        .expect(201)
    ).body as Claim;
    // Staff ask for them back and mark them received.
    await staff.post(`/claims/${faulty.id}/return`).expect(200);
    expect((await portalClaim(faulty.id)).state).toBe('awaiting_return');
    await staff.post(`/claims/${faulty.id}/returned`).expect(200);

    // CastCo made them: a remake, offered back to CastCo at cost 0; its score counts the claim.
    const castcoOwed = await owedFor(castco.id, rings.lines[0].group_id);
    const remade = (await decide(faulty, { fault: 'workshop', outcome: 'remake', note: 'Porous casting' })).body as Decided;
    const remake = remade.remake!.group_id;
    expect(remade.remake!.unassigned_reasons).toEqual([]);
    const jobs = ((await staff.get(`/partners/jobs/${remake}`).expect(200)).body as { data: { partner: { id: string }; status: string; cost: string }[] }).data;
    expect(jobs).toEqual([expect.objectContaining({ partner: expect.objectContaining({ id: castco.id }), status: 'offered', cost: '0.00' })]);
    const score = ((await staff.get(`/partners/${castco.id}`).expect(200)).body as { score: { parts: { claims: number } } }).score;
    expect(score.parts.claims).toBeLessThan(1);
    // Luna sees the decision, never whose fault it was.
    expect((await portalClaim(faulty.id)).lines[0].decision).toEqual({ outcome: 'remake', customer_reason: null, refund_amount: null, remake_group_id: remake });

    // CastCo declines; MetalWorks takes it at its normal cost, and CastCo is owed that much less.
    await castco.person.post(`/partner-portal/partners/${castco.id}/jobs/${remake}/decline`).expect(200);
    const offered = (await staff.post(`/partners/jobs/${remake}/offer`, { partner_id: metalworks.id }).expect(201)).body as { cost: string };
    await metalworks.person.post(`/partner-portal/partners/${metalworks.id}/jobs/${remake}/accept`).expect(200);
    const reduced = Prisma.Decimal.min(d(offered.cost), d(castcoOwed.amount));
    expect((await owedFor(castco.id, rings.lines[0].group_id)).amount).toBe(d(castcoOwed.amount).sub(reduced).toFixed(2));

    // 2. A partial refund on another paid order of CastCo's: CastCo is owed the claimed pieces' share less.
    const pendants = await delivered(luna, 10, castco);
    const pendantsOwed = await owedFor(castco.id, pendants.lines[0].group_id);
    const scratched = (
      await buyer
        .post(`/portal/customers/${luna}/orders/${pendants.id}/claims`, { reason: 'defect', description: 'Scratched.', lines: [{ position: 0, pieces: 2 }] })
        .expect(201)
    ).body as Claim;
    await decide(scratched, { fault: 'workshop', outcome: 'refund', refund_amount: '5.00' });
    const refunds = await prisma.inTenant(tenant.id, (tx) => tx.refund.findMany({ where: { orderId: pendants.id } }));
    expect(refunds.map((row) => [row.amount.toFixed(2), row.status])).toEqual([['5.00', 'succeeded']]);
    const share = d(pendantsOwed.amount).mul(2).div(10).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    expect((await owedFor(castco.id, pendants.lines[0].group_id)).amount).toBe(d(pendantsOwed.amount).sub(share).toFixed(2));

    // Brightline's unpaid order: the refund becomes a credit note on its open invoice.
    const unpaid = await delivered(brightline, 2);
    const crushed = (
      await staff
        .post(`/orders/${unpaid.id}/claims`, { reason: 'damaged_in_transit', description: 'Crushed parcel.', lines: [{ position: 0, pieces: 2 }] })
        .expect(201)
    ).body as Claim;
    await decide(crushed, { fault: 'courier', outcome: 'refund', refund_amount: '10.00' });
    const [note] = await waitFor(async () => {
      const rows = await prisma.inTenant(tenant.id, (tx) => tx.creditNote.findMany({ where: { orderId: unpaid.id } }));
      return rows.length > 0 && rows.every((row) => row.status === 'issued') ? rows : undefined;
    });
    expect(note.amount.toFixed(2)).toBe('10.00');
    const invoice = await prisma.inTenant(tenant.id, (tx) => tx.invoice.findFirstOrThrow({ where: { orderId: unpaid.id } }));
    expect(fake.invoiceCredited(invoice.providerInvoiceId!).toFixed(2)).toBe('10.00');
    expect(((await staff.get(`/orders/${unpaid.id}`).expect(200)).body as Order).payment.invoice).toMatchObject({ status: 'open', credited: '10.00' });

    // Another claim is refused, with a reason Luna sees.
    const dropped = (
      await buyer
        .post(`/portal/customers/${luna}/orders/${rings.id}/claims`, { reason: 'defect', description: 'Bent.', lines: [{ position: 0, pieces: 1 }] })
        .expect(201)
    ).body as Claim;
    await decide(dropped, { fault: 'customer', outcome: 'refuse', customer_reason: 'The ring was bent by a fall.' });
    expect((await portalClaim(dropped.id)).lines[0].decision).toMatchObject({ outcome: 'refuse', customer_reason: 'The ring was bent by a fall.' });

    // 3. On the 1st: the accountant's files for the accountant, the top customers for the owner.
    await staff
      .put('/settings/reports.schedules', {
        accounting: { enabled: true, recipientUserIds: [accountantUser.id] },
        top_customers: { enabled: true, recipientUserIds: [owner.id] },
      })
      .expect(200);
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 6));
    expect(await app.get(ScheduledExportsService).runDue(tenant.id, first)).toHaveLength(5);

    const toldOf = (userId: string) =>
      waitFor(
        async () => {
          const found = await prisma.inTenant(tenant.id, (tx) => tx.notification.findMany({ where: { eventKey: 'export.scheduled_ready', subjectId: userId } }));
          return found.length > 0 ? found : undefined;
        },
        30_000,
      );
    const download = async (client: Client, id: string) => {
      const link = (await client.post(`/reports/exports/${id}/download`).expect(200)).body as { url: string };
      return parse(Buffer.from(await (await fetch(link.url)).arrayBuffer()));
    };
    const scheduled = (kind: string) =>
      prisma.inTenant(tenant.id, (tx) => tx.reportExport.findFirstOrThrow({ where: { scheduleKey: `${kind}:${month}` } }));

    // The accountant is told, downloads the invoices, and can't change anything.
    const [accountantNotice] = await toldOf(accountantUser.id);
    expect(accountantNotice.payload).toMatchObject({ schedule: 'accounting', month });
    const invoices = await download(accountant, (await scheduled('accounting_invoices')).id);
    expect(invoices.length).toBeGreaterThan(1);
    await accountant.post(`/orders/${rings.id}/cancel`, { reason: 'Not allowed' }).expect(403);
    await accountant.put('/settings/reports.schedules', { accounting: { enabled: false, recipientUserIds: [] }, top_customers: { enabled: false, recipientUserIds: [] } }).expect(403);

    // The owner is told of the top customers: Luna first by revenue, with its three claims and one remake.
    const [ownerNotice] = await toldOf(owner.id);
    expect(ownerNotice.payload).toMatchObject({ schedule: 'top customers', month });
    const [header, ...customers] = await download(staff, (await scheduled('top_customers')).id);
    const column = (name: string) => header.indexOf(name);
    expect(customers.map((row) => [row[column('Customer')], row[column('Claims')], row[column('Remakes')]])).toEqual([
      ['Luna Jewels', '3', '1'],
      ['Brightline', '1', '0'],
    ]);
  });
});
