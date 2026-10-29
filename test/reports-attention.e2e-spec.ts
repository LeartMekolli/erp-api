import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { ATTENTION_KINDS } from '../src/modules/reporting/attention.service';
import { dashboardResponseSchema } from '../src/modules/reporting/dashboard-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Attention {
  kind: string;
  total: number;
  items: { ref: { type: string; id: string }; label: string; since: string | null }[];
}

const HOUR_MS = 3_600_000;
const SETUP_MS = 120_000;

/** What needs attention now: live rules, no AI, by permission (AI 1 plan, Task 4). */
describe('reporting: needs attention', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });
  type Client = ReturnType<typeof as>;

  let staff: Client;
  let operator: Client;
  const atRisk: string[] = [];
  let fresh: string;
  let waiting: string;
  let invoiceId: string;
  let partnerId: string;
  let offerId: string;

  /**
   * One workspace: 25 orders promised yesterday and still in production; one promised in 10 working
   * days; one waiting for payment; one with an invoice 5 days overdue; and a 19-piece job offered 25
   * hours ago to a partner whose capacity is 20 a week. An operator reads reports, orders and partners,
   * but not payments.
   */
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);

    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const reader = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      const role = await tx.role.create({ data: { name: 'operator', isSystem: false } });
      await tx.rolePermission.createMany({
        data: ['report.read', 'order.read', 'partner.read', 'workflow.read'].map((permission) => ({ roleId: role.id, permission })),
      });
      await tx.userRole.create({ data: { userId: reader.id, roleId: role.id } });
    });
    staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    operator = as((await tokens.issueForUser(tenant.id, reader.id)).accessToken);

    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    const speeds = (await staff.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] };
    await staff.patch(`/pricing/delivery-speeds/${speeds.data.find((speed) => speed.key === 'standard')!.id}`, { working_days: 10 }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/orders/tax-rates', { rates: [{ country: null, region: null, percent: '0' }] }).expect(200);
    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    await staff.put(`/customers/${luna}/payment-terms`, { terms: 'pay_later' }).expect(200);

    const order = async (quantity: number) => {
      const quote = ((
        await staff
          .post('/pricing/quotes', {
            product_id: cast.productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity,
            file_version_id: cast.versionId,
            customer_id: luna,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote;
      const placed = await staff
        .post('/orders', {
          customer_id: luna,
          lines: [{ quote_id: quote.id }],
          address: { name: 'Luna Jewels', line1: 'Main street 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
          shipping_method: 'courier',
        })
        .expect(201);
      const body = placed.body as { id: string; total: string; lines: { group_id: string }[] };
      return { id: body.id, total: body.total, groupId: body.lines[0].group_id };
    };

    for (let index = 0; index < 25; index += 1) atRisk.push((await order(1)).id);
    fresh = (await order(1)).id;
    waiting = (await order(1)).id;
    const invoiced = await order(1);
    const job = await order(19);

    const today = new Date().toISOString().slice(0, 10);
    const daysFromToday = (days: number) => new Date(new Date(`${today}T00:00:00Z`).getTime() + days * 24 * HOUR_MS);

    partnerId = ((await staff.post('/partners', { name: 'Northcast Foundry', display_name: 'Northcast' }).expect(201)).body as { id: string }).id;
    const { printPattern, castingTree, casting, polishing } = cast.steps;
    await staff
      .put(`/partners/${partnerId}/capabilities`, {
        capabilities: [printPattern, castingTree, casting, polishing].map((step_type_id) => ({ step_type_id, capacity: 20, capacity_period: 'week' })),
      })
      .expect(200);

    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.order.updateMany({ where: { id: { in: atRisk } }, data: { promisedOn: daysFromToday(-1) } });
      await tx.order.update({ where: { id: waiting }, data: { productionStartedAt: null } });
      invoiceId = (
        await tx.invoice.create({
          data: {
            orderId: invoiced.id,
            linesAmount: new Prisma.Decimal(invoiced.total).sub('9.90'),
            shipping: new Prisma.Decimal('9.90'),
            tax: new Prisma.Decimal(0),
            total: new Prisma.Decimal(invoiced.total),
            currency: 'EUR',
            dueOn: daysFromToday(-5),
            status: 'open',
            // An open invoice exists at the provider (invoice_made_check).
            providerInvoiceId: `in_test_${randomBytes(6).toString('hex')}`,
            url: 'https://pay.example.test/invoice/1',
          },
        })
      ).id;
      offerId = (
        await tx.jobAssignment.create({
          data: {
            groupId: job.groupId,
            partnerId,
            kind: 'offer',
            status: 'offered',
            cost: new Prisma.Decimal('100.00'),
            expiresAt: new Date(Date.now() + 24 * HOUR_MS),
            createdByUserId: owner.id,
            createdAt: new Date(Date.now() - 25 * HOUR_MS),
          },
        })
      ).id;
    });
  }, SETUP_MS);

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  const attentionOf = async (client: Client) => {
    const response = await client.get('/reports/dashboard').expect(200);
    expectDocumented(dashboardResponseSchema, response.body);
    return (response.body as { attention: Attention[] }).attention;
  };
  const kind = (attention: Attention[], name: string) => attention.find((one) => one.kind === name);
  const refs = (attention: Attention[], name: string) => kind(attention, name)?.items.map((item) => item.ref) ?? [];

  it('lists every kind to the owner, each with its total, even when nothing is in it', async () => {
    const attention = await attentionOf(staff);

    expect(attention.map((one) => one.kind)).toEqual([...ATTENTION_KINDS]);
    expect(kind(attention, 'subscription_past_due')).toEqual({ kind: 'subscription_past_due', total: 0, items: [] });
  });

  it('lists orders past or near their promised date, at most 20 of them, and not one promised in 10 working days', async () => {
    const attention = await attentionOf(staff);

    const risky = kind(attention, 'order_at_risk')!;
    expect(risky.total).toBe(25);
    expect(risky.items).toHaveLength(20);
    for (const item of risky.items) {
      expect(item.ref.type).toBe('order');
      expect(atRisk).toContain(item.ref.id);
    }
    expect(risky.items.map((item) => item.ref.id)).not.toContain(fresh);
  });

  it('lists an order waiting for payment, an overdue invoice, a nearly full partner and an offer unanswered for a day', async () => {
    const attention = await attentionOf(staff);

    expect(refs(attention, 'awaiting_payment')).toEqual([{ type: 'order', id: waiting }]);
    expect(refs(attention, 'invoice_overdue')).toEqual([{ type: 'invoice', id: invoiceId }]);
    const full = kind(attention, 'partner_near_capacity')!;
    expect(full.items.map((item) => item.ref)).toEqual([{ type: 'partner', id: partnerId }]);
    expect(full.items[0].label).toContain('95');
    expect(refs(attention, 'offer_unanswered')).toEqual([{ type: 'job', id: offerId }]);
  });

  it('shows no payment kind to staff without payment.read', async () => {
    const attention = await attentionOf(operator);

    const kinds = attention.map((one) => one.kind);
    for (const hidden of ['awaiting_payment', 'credit_hold', 'invoice_overdue', 'subscription_past_due']) {
      expect(kinds).not.toContain(hidden);
    }
    expect(kind(attention, 'order_at_risk')?.total).toBe(25);
    expect(kinds).toContain('partner_near_capacity');
  });
});
