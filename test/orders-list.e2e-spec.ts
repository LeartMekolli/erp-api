import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import type { Prisma } from '../src/generated/prisma/client';
import { AI_TOOLS } from '../src/modules/ai/tools/tool';
import type { AiTool } from '../src/modules/ai/tools/tool';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { orderResponseSchema } from '../src/modules/orders/order-response';
import { OrderStatesService } from '../src/modules/orders/order-states.service';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Order {
  id: string;
  number: number;
  state: string;
  promised_on: string;
  placed_at: string;
  lines: { group_id: string }[];
  payment: { state: string };
}
interface Page {
  data: Order[];
  next_cursor: string | null;
}

/**
 * The staff orders list filters by state, payment state and promised date, searches part of the order
 * number and the customer's name, and sorts by placed or promised date, a page at a time (Orders list
 * spec, goals 8–10; plan Task 4).
 */
describe('orders: the staff list', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none, so silver is at its fallback.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });
  const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };

  /** The priced cast part, published; `courier`; Luna Jewels paying later, Sol Rings paying first (no terms set). */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const sol = ((await staff.post('/customers', { name: 'Sol Rings' }).expect(201)).body as { id: string }).id;
    await staff.put(`/customers/${luna}/payment-terms`, { terms: 'pay_later' }).expect(200);

    const place = async (customerId: string) => {
      const quote = (
        (
          await staff
            .post('/pricing/quotes', {
              product_id: cast.productId,
              options: { material: 'silver_925', finish: 'polished' },
              size: { scale: '1.5' },
              quantity: 1,
              file_version_id: cast.versionId,
              customer_id: customerId,
            })
            .expect(201)
        ).body as { quote: { id: string } }
      ).quote.id;
      return (await staff.post('/orders', { customer_id: customerId, lines: [{ quote_id: quote }], address, shipping_method: 'courier' }).expect(201))
        .body as Order;
    };
    return { id: tenant.id, staff, luna, sol, place };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** Changes facts directly, then stores the order's states again, as every real change does. */
  const fake = (tenant: Tenant, orderId: string, change: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    prisma.inTenant(tenant.id, async (tx) => {
      await change(tx);
      await app.get(OrderStatesService).refresh(tx, [orderId]);
    });
  const finish = (tenant: Tenant, order: Order) =>
    fake(tenant, order.id, (tx) =>
      tx.workOrder.updateMany({ where: { groupId: { in: order.lines.map((line) => line.group_id) } }, data: { status: 'finished', currentStepId: null } }),
    );
  const promise = (tenant: Tenant, order: Order, day: string) =>
    prisma.inTenant(tenant.id, (tx) => tx.order.update({ where: { id: order.id }, data: { promisedOn: new Date(`${day}T00:00:00Z`) } }));

  /**
   * One workspace, numbered 1001–1006 in this order: Sol's pay-first order waiting; two of Luna's in
   * production; one ready; one shipped with its invoice overdue; one cancelled. Three are promised on D.
   */
  const D = '2030-01-10';
  let w: Tenant;
  let other: Tenant;
  let o: Record<'waiting' | 'making1' | 'making2' | 'ready' | 'overdue' | 'cancelled', Order>;
  let foreign: Order;
  const promisedOn = new Map<string, string>();

  /** The ids `GET /orders?<query>` lists on one page of up to 200, checked against its documented shape. */
  const ids = async (query: string, by: Tenant = w) => {
    const response = await by.staff.get(`/orders?limit=200&${query}`).expect(200);
    expectDocumented(pageSchema(orderResponseSchema), response.body);
    return (response.body as Page).data.map((order) => order.id);
  };
  const idsOf = (...orders: Order[]) => orders.map((order) => order.id).sort();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);

    w = await freshTenant();
    o = {
      waiting: await w.place(w.sol),
      making1: await w.place(w.luna),
      making2: await w.place(w.luna),
      ready: await w.place(w.luna),
      overdue: await w.place(w.luna),
      cancelled: await w.place(w.luna),
    };
    await finish(w, o.ready);
    await finish(w, o.overdue);
    await w.staff.post(`/orders/${o.overdue.id}/ship`, {}).expect(200);
    // The invoice as the provider made it, due yesterday: no provider is connected here.
    await fake(w, o.overdue.id, (tx) =>
      tx.invoice.create({
        data: {
          orderId: o.overdue.id,
          providerInvoiceId: `in_${o.overdue.id.replaceAll('-', '')}`,
          url: 'https://invoices.example.test/1',
          linesAmount: '10.00',
          shipping: '0.00',
          tax: '0.00',
          total: '10.00',
          currency: 'EUR',
          dueOn: new Date('2000-01-01T00:00:00Z'),
          status: 'open',
        },
      }),
    );
    await w.staff.post(`/orders/${o.cancelled.id}/cancel`, { reason: 'Changed their mind' }).expect(200);
    const days: [Order, string][] = [
      [o.waiting, '2030-01-08'],
      [o.making1, D],
      [o.making2, D],
      [o.ready, D],
      [o.overdue, '2030-01-12'],
      [o.cancelled, '2030-01-14'],
    ];
    for (const [order, day] of days) {
      await promise(w, order, day);
      promisedOn.set(order.id, day);
    }

    other = await freshTenant();
    foreign = await other.place(other.luna);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('is built as the tests expect', async () => {
    const shown = (await w.staff.get('/orders?limit=200').expect(200)).body as Page;
    const byId = new Map(shown.data.map((order) => [order.id, order]));
    expect(Object.values(o).map((order) => [byId.get(order.id)!.number, byId.get(order.id)!.state, byId.get(order.id)!.payment.state])).toEqual([
      [1001, 'awaiting_payment', 'awaiting_payment'],
      [1002, 'in_production', 'not_billed'],
      [1003, 'in_production', 'not_billed'],
      [1004, 'ready', 'not_billed'],
      [1005, 'shipped', 'overdue'],
      [1006, 'cancelled', 'none'],
    ]);
  });

  it('filters by several states', async () => {
    expect((await ids('state=in_production,ready')).sort()).toEqual(idsOf(o.making1, o.making2, o.ready));
    // A state named twice is one.
    expect((await ids('state=ready,ready')).sort()).toEqual(idsOf(o.ready));
  });

  it('filters by payment state', async () => {
    expect(await ids('payment_state=overdue')).toEqual([o.overdue.id]);
    expect((await ids('payment_state=awaiting_payment,overdue')).sort()).toEqual(idsOf(o.waiting, o.overdue));
  });

  it('filters by promised date: on or after promised_after, before promised_before', async () => {
    expect((await ids(`promised_after=${D}`)).sort()).toEqual(idsOf(o.making1, o.making2, o.ready, o.overdue, o.cancelled));
    expect(await ids(`promised_before=${D}`)).toEqual([o.waiting.id]);
    expect((await ids(`promised_after=${D}&promised_before=2030-01-11`)).sort()).toEqual(idsOf(o.making1, o.making2, o.ready));
  });

  it("searches part of the order number and the customer's name", async () => {
    expect((await ids('q=100')).sort()).toEqual(idsOf(...Object.values(o)));
    expect(await ids('q=1003')).toEqual([o.making2.id]);
    expect(await ids('q=%231003')).toEqual([o.making2.id]);
    expect((await ids('q=luna')).sort()).toEqual(idsOf(o.making1, o.making2, o.ready, o.overdue, o.cancelled));
    expect(await ids('q=sol%20ri')).toEqual([o.waiting.id]);

    // Digits in a name are found too.
    await prisma.inTenant(w.id, (tx) => tx.customer.update({ where: { id: w.sol }, data: { name: 'Sol 1003 Rings' } }));
    try {
      expect((await ids('q=1003')).sort()).toEqual(idsOf(o.waiting, o.making2));
    } finally {
      await prisma.inTenant(w.id, (tx) => tx.customer.update({ where: { id: w.sol }, data: { name: 'Sol Rings' } }));
    }
  });

  it('sorts by promised date both ways, paging ties by id (Review Focus 3)', async () => {
    const expected = Object.values(o)
      .map((order) => ({ id: order.id, day: promisedOn.get(order.id)! }))
      .sort((a, b) => (a.day === b.day ? a.id.localeCompare(b.id) : a.day.localeCompare(b.day)))
      .map((row) => row.id);

    const paged = async (sort: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const response = await w.staff.get(`/orders?sort=${sort}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
        const page = response.body as Page;
        expectDocumented(pageSchema(orderResponseSchema), page);
        seen.push(...page.data.map((order) => order.id));
        cursor = page.next_cursor;
      } while (cursor && seen.length <= 10);
      return seen;
    };
    expect(await paged('promised_on')).toEqual(expected);
    expect(await paged('-promised_on')).toEqual([...expected].reverse());
  });

  it('sorts by placed date, newest first unless asked otherwise', async () => {
    const newest = await ids('');
    expect(newest).toEqual(Object.values(o).map((order) => order.id).reverse());
    expect(await ids('sort=-placed_at')).toEqual(newest);
    expect(await ids('sort=placed_at')).toEqual([...newest].reverse());
  });

  it('lists an order not computed yet in no state filter, only unfiltered', async () => {
    await prisma.inTenant(w.id, (tx) => tx.order.update({ where: { id: o.making1.id }, data: { state: null, paymentState: null } }));
    try {
      expect(await ids('state=in_production')).toEqual([o.making2.id]);
      expect(await ids('payment_state=not_billed')).not.toContain(o.making1.id);
      expect(await ids('')).toContain(o.making1.id);
    } finally {
      await prisma.inTenant(w.id, (tx) => app.get(OrderStatesService).refresh(tx, [o.making1.id]));
    }
  });

  it('refuses bad input with a 400 (Review Focus 5)', async () => {
    for (const query of [
      'state=shipped,lost',
      'state=',
      'payment_state=late',
      'sort=total',
      'promised_before=tomorrow',
      'promised_after=2030-13-01',
      'color=red',
      `q=${'x'.repeat(101)}`,
    ]) {
      const response = await w.staff.get(`/orders?${query}`);
      expect([query, response.status]).toEqual([query, 400]);
    }

    const byPromise = (await w.staff.get('/orders?sort=promised_on&limit=1').expect(200)).body as Page;
    await w.staff.get(`/orders?sort=placed_at&cursor=${encodeURIComponent(byPromise.next_cursor!)}`).expect(400);
    await w.staff.get(`/orders?cursor=${encodeURIComponent(byPromise.next_cursor!)}`).expect(400);
    const byNewest = (await w.staff.get('/orders?limit=1').expect(200)).body as Page;
    await w.staff.get(`/orders?sort=promised_on&cursor=${encodeURIComponent(byNewest.next_cursor!)}`).expect(400);
    const tampered = `${byPromise.next_cursor!.slice(0, 5)}${byPromise.next_cursor![5] === 'A' ? 'B' : 'A'}${byPromise.next_cursor!.slice(6)}`;
    await w.staff.get(`/orders?sort=promised_on&cursor=${encodeURIComponent(tampered)}`).expect(400);
  });

  it("never lists another workspace's orders, whatever the filter or search", async () => {
    for (const query of ['', 'q=100', 'q=1001', 'q=luna', 'state=in_production', 'payment_state=not_billed', 'sort=promised_on', `promised_after=2000-01-01`]) {
      // Each workspace lists its own orders only: the other's single order, numbered 1001 too, never shows here.
      expect([query, (await ids(query)).includes(foreign.id)]).toEqual([query, false]);
      const theirs = await ids(query, other);
      expect([query, theirs.filter((id) => id !== foreign.id)]).toEqual([query, []]);
    }
  });

  describe('needs you (plan Task 5)', () => {
    /** Today in the workspace (UTC, as test workspaces are), `days` on. */
    const fromToday = (days: number) => new Date(Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    let n: Tenant;
    let r: Record<'late' | 'soon' | 'ready' | 'waiting' | 'overdue' | 'calm', Order>;

    /** Every staff order of `n` with its `needs`, as the list shows them. */
    const needsOf = async () => {
      const page = (await n.staff.get('/orders?limit=200').expect(200)).body as { data: (Order & { needs: string[] })[] };
      expectDocumented(pageSchema(orderResponseSchema), page);
      return new Map(page.data.map((order) => [order.id, order.needs]));
    };

    beforeAll(async () => {
      n = await freshTenant();
      r = {
        late: await n.place(n.luna),
        soon: await n.place(n.luna),
        ready: await n.place(n.luna),
        waiting: await n.place(n.sol),
        overdue: await n.place(n.luna),
        calm: await n.place(n.luna),
      };
      for (const order of Object.values(r)) await promise(n, order, fromToday(30));
      await promise(n, r.late, fromToday(-1));
      await promise(n, r.soon, fromToday(0));
      await finish(n, r.ready);
      await finish(n, r.overdue);
      await n.staff.post(`/orders/${r.overdue.id}/ship`, {}).expect(200);
      await fake(n, r.overdue.id, (tx) =>
        tx.invoice.create({
          data: {
            orderId: r.overdue.id,
            providerInvoiceId: `in_${r.overdue.id.replaceAll('-', '')}`,
            url: 'https://invoices.example.test/2',
            linesAmount: '10.00',
            shipping: '0.00',
            tax: '0.00',
            total: '10.00',
            currency: 'EUR',
            dueOn: new Date('2000-01-01T00:00:00Z'),
            status: 'open',
          },
        }),
      );
    });

    it('gives each staff order the reasons it needs attention', async () => {
      const needs = await needsOf();
      expect(Object.fromEntries(Object.entries(r).map(([name, order]) => [name, needs.get(order.id)]))).toEqual({
        late: ['late'],
        soon: ['due_soon'],
        ready: ['to_ship'],
        waiting: ['to_collect'],
        overdue: ['to_collect'],
        calm: [],
      });
    });

    it('agrees with the needs filter, reason by reason and all together', async () => {
      const needs = await needsOf();
      for (const reason of ['late', 'to_ship', 'to_collect', 'due_soon']) {
        const expected = [...needs].filter(([, reasons]) => reasons.includes(reason)).map(([id]) => id).sort();
        expect([reason, (await ids(`needs=${reason}`, n)).sort()]).toEqual([reason, expected]);
      }
      const any = [...needs].filter(([, reasons]) => reasons.length > 0).map(([id]) => id).sort();
      expect((await ids('needs=late,to_ship,to_collect,due_soon', n)).sort()).toEqual(any);
      // Combined with the other filters by AND.
      expect(await ids('needs=to_collect&state=shipped', n)).toEqual([r.overdue.id]);
    });

    it('refuses a reason it does not know', async () => {
      await n.staff.get('/orders?needs=urgent').expect(400);
      await n.staff.get('/orders?needs=').expect(400);
    });

    it("leaves `needs` out of the customer's own view of an order", async () => {
      const user = await createTestUser(prisma, n.id, { roles: [] });
      await prisma.inTenant(n.id, async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { kind: 'customer' } });
        await tx.organisationMembership.create({ data: { userId: user.id, organisationType: 'customer', organisationId: n.luna, role: 'buyer' } });
      });
      const buyer = as((await tokens.issueForUser(n.id, user.id)).accessToken);
      const seen = (await buyer.get(`/portal/customers/${n.luna}/orders/${r.late.id}`).expect(200)).body as Record<string, unknown>;
      expect(seen).not.toHaveProperty('needs');
    });

    it('counts a ready order past its promised date as at risk on the dashboard, and late for the assistant', async () => {
      await promise(n, r.ready, fromToday(-1));
      try {
        const dashboard = (await n.staff.get('/reports/dashboard').expect(200)).body as {
          attention: { kind: string; items: { ref: { id: string } }[] }[];
        };
        const atRisk = dashboard.attention.find((group) => group.kind === 'order_at_risk')!.items.map((item) => item.ref.id);
        expect(atRisk.sort()).toEqual(idsOf(r.late, r.soon, r.ready));

        const findOrders = (app.get(AI_TOOLS) as AiTool<unknown>[]).find((tool) => tool.name === 'find_orders')!;
        const owner = await prisma.inTenant(n.id, (tx) => tx.user.findFirstOrThrow({ where: { kind: 'staff' } }));
        const found = await findOrders.run({ tenantId: n.id, permissions: new Set(['order.read']), userId: owner.id }, { late: true });
        expect((found.data as { id: string }[]).map((order) => order.id).sort()).toEqual(idsOf(r.late, r.ready));
      } finally {
        await promise(n, r.ready, fromToday(30));
      }
    });
  });
});
