import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedCatalog } from '../src/cli/seed-catalog';
import { seedCustomers } from '../src/cli/seed-customers';
import { seedOrders } from '../src/cli/seed-orders';
import { seedPartners } from '../src/cli/seed-partners';
import { seedPricing } from '../src/cli/seed-pricing';
import { seedWorkflows } from '../src/cli/seed-workflows';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { promisedDate } from '../src/modules/orders/dates';
import { measuredDesign } from './catalog-fixtures';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'demo-password-123';
const CALENDAR = { workingDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17, closedDates: [] };
const HOUR_MS = 3_600_000;

interface Quote {
  id: string;
  total: string;
}
interface Order {
  id: string;
  number: number;
  state: string;
  promised_on: string;
  placed_at: string;
  shipping: { price: string; courier: string | null; tracking: string | null };
  lines: { position: number; state: string; group_id?: string; partner?: { id: string } | null }[];
  lines_total: string;
  tax: { percent: string; amount: string };
  total: string;
}

/**
 * The Orders spec's "Done when" 1, 2, 3, 4 (an offer, without a due date until Orders 2), 5, 7 and 9,
 * end to end over HTTP on the demo data, as staff, Luna's buyer Ben and Northcast's owner.
 */
describe('orders: the walkthrough', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app?.close();
  });

  it('runs from setting up to a delivered order, with lapsed prices, cancelling and picked workshops', async () => {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    await seedCatalog(prisma, tenant.id);
    await seedPricing(prisma, tenant.id);
    await seedWorkflows(prisma, tenant.id);
    await seedCustomers(prisma, tenant.id, { password: PASSWORD });
    await seedPartners(prisma, tenant.id, { password: PASSWORD });
    await seedOrders(prisma, tenant.id);
    const staffUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, staffUser.id)).accessToken);

    const ids = await prisma.inTenant(tenant.id, async (tx) => ({
      castPart: (await tx.product.findFirstOrThrow({ where: { key: 'custom_cast_part' } })).id,
      resinPrint: (await tx.product.findFirstOrThrow({ where: { key: 'custom_resin_print' } })).id,
      northcast: (await tx.partner.findFirstOrThrow({ where: { name: 'Northcast Foundry' } })).id,
      layerline: (await tx.partner.findFirstOrThrow({ where: { name: 'Layerline Prints' } })).id,
      timezone: (await tx.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).timezone,
    }));
    const login = async (email: string) => {
      const response = await http().post('/auth/login').send({ email, password: PASSWORD, workspace: tenant.slug }).expect(200);
      return as((response.body as { access_token: string }).access_token);
    };
    const counts = () =>
      prisma.inTenant(tenant.id, async (tx) => ({
        orders: await tx.order.count(),
        groups: await tx.workOrderGroup.count(),
        assignments: await tx.jobAssignment.count(),
      }));

    // 1. Staff hold prices for 4 hours, work Monday to Friday, tax Germany at 19 %; the demo has two
    // shipping methods and delivery speeds promising working days.
    await staff.put('/pricing/profile', { margin_percent: '40', overhead_per_piece: '2', quote_valid_hours: 4 }).expect(200);
    await staff.put('/settings/business.calendar', CALENDAR).expect(200);
    await staff
      .put('/orders/tax-rates', {
        rates: [
          { country: null, region: null, percent: '0' },
          { country: 'DE', region: null, percent: '19' },
        ],
      })
      .expect(200);
    const methods = ((await staff.get('/orders/shipping-methods').expect(200)).body as { data: { key: string; active: boolean }[] }).data;
    expect(methods.filter((method) => method.active).map((method) => method.key)).toEqual(['collect', 'courier']);
    const speeds = ((await staff.get('/pricing/delivery-speeds').expect(200)).body as { data: { key: string; working_days: number }[] }).data;
    expect(Object.fromEntries(speeds.map((speed) => [speed.key, speed.working_days]))).toEqual({ standard: 10, express: 5, rush: 2 });

    // 2. Ben prices 10 polished parts and orders them: numbered, promised, taxed, in production. In
    // brass, priced by hand: silver follows the metal feed, whose snapshots are platform-wide and
    // could change a price between two quotes of this test.
    const ben = await login('ben@luna.example.test');
    const me = (await ben.get('/portal/me').expect(200)).body as { user: { id: string }; customers: { id: string }[] };
    const luna = me.customers[0].id;
    const portal = `/portal/customers/${luna}`;
    const castDesign = (await measuredDesign(prisma, tenant.id, me.user.id, { customerId: luna })).versionId;
    const castQuote = async (extra: object = {}) =>
      ((
        await ben
          .post(`${portal}/quotes`, {
            product_id: ids.castPart,
            options: { material: 'brass', finish: 'polished' },
            size: { scale: '1.5' },
            quantity: 10,
            file_version_id: castDesign,
            delivery_speed: 'standard',
            ...extra,
          })
          .expect(201)
      ).body as { quote: Quote }).quote;
    const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
    const order = (quoteIds: string[]) =>
      ben.post(`${portal}/orders`, { lines: quoteIds.map((quote_id) => ({ quote_id })), address, shipping_method: 'courier' });
    const staffView = async (id: string) => (await staff.get(`/orders/${id}`).expect(200)).body as Order;
    const pieceIds = async (groupId: string) =>
      (await prisma.inTenant(tenant.id, (tx) => tx.workOrder.findMany({ where: { groupId }, orderBy: { number: 'asc' } }))).map((piece) => piece.id);

    const rings = await castQuote();
    const first = (await order([rings.id]).expect(201)).body as Order;
    const tax = new Prisma.Decimal(rings.total).plus('9.90').times('0.19').toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    expect(first).toMatchObject({
      number: 1001,
      state: 'in_production',
      shipping: { price: '9.90' },
      lines_total: rings.total,
      tax: { percent: '19', amount: tax.toFixed(2) },
      total: new Prisma.Decimal(rings.total).plus('9.90').plus(tax).toFixed(2),
      lines: [expect.objectContaining({ state: 'in_production' })],
    });
    expect(first.promised_on).toBe(promisedDate(new Date(first.placed_at), 10, CALENDAR, ids.timezone));
    const firstGroup = (await staffView(first.id)).lines[0].group_id!;
    expect(await pieceIds(firstGroup)).toHaveLength(10);

    // 3. A quote made 5 hours ago, its price unchanged, still places; one whose price changed is
    // answered with the new quote, which then orders.
    const lapse = (quoteId: string) =>
      prisma.inTenant(tenant.id, (tx) =>
        tx.quote.update({ where: { id: quoteId }, data: { createdAt: new Date(Date.now() - 5 * HOUR_MS), expiresAt: new Date(Date.now() - HOUR_MS) } }),
      );
    const old = await castQuote();
    await lapse(old.id);
    const second = (await order([old.id]).expect(201)).body as Order;
    expect(second.total).toBe(first.total);

    const changing = await castQuote();
    await lapse(changing.id);
    await staff.put('/pricing/profile', { margin_percent: '45', overhead_per_piece: '2', quote_valid_hours: 4 }).expect(200);
    const refused = (await order([changing.id]).expect(409)).body as { code: string; lines: { quote: Quote | null }[] };
    expect(refused.code).toBe('price_changed');
    const fresh = refused.lines[0].quote!;
    expect(fresh.total).not.toBe(changing.total);
    expect(((await order([fresh.id]).expect(201)).body as Order).lines_total).toBe(fresh.total);

    // 4. The second order's line has no partner: made in-house unless offered. Staff offer it to
    // Northcast, which sees the job and never Luna, her order or her price.
    const secondLine = (await staffView(second.id)).lines[0];
    expect(secondLine.partner).toBeNull();
    await staff.post(`/partners/jobs/${secondLine.group_id}/offer`, { partner_id: ids.northcast }).expect(201);
    const nora = await login('owner@northcast.example.test');
    const jobs = await nora.get(`/partner-portal/partners/${ids.northcast}/jobs`).expect(200);
    expect((jobs.body as { data: { id: string; status: string }[] }).data).toEqual([expect.objectContaining({ id: secondLine.group_id, status: 'offered' })]);
    for (const secret of [luna, 'Luna', second.id, old.id, second.total]) {
      expect({ secret, found: jobs.text.includes(secret) }).toEqual({ secret, found: false });
    }

    // 9. Ben cancels an order no piece of which has moved. Once a piece of the second order has
    // moved he can't, but staff can, and Northcast's open offer on it is withdrawn.
    const third = (await order([(await castQuote()).id]).expect(201)).body as Order;
    expect(((await ben.post(`${portal}/orders/${third.id}/cancel`, { reason: 'Ordered twice' }).expect(200)).body as Order).state).toBe('cancelled');
    const [moved] = await pieceIds(secondLine.group_id!);
    await staff.post('/workflow/moves', { work_order_ids: [moved], kind: 'pass', at_step: 'print_pattern' }).expect(200);
    await ben.post(`${portal}/orders/${second.id}/cancel`, { reason: 'Too slow' }).expect(409);
    expect(((await staff.post(`/orders/${second.id}/cancel`, { reason: 'Luna phoned' }).expect(200)).body as Order).state).toBe('cancelled');
    const offers = (await staff.get(`/partners/jobs/${secondLine.group_id}`).expect(200)).body as { data: { status: string }[] };
    expect(offers.data.map((row) => row.status)).toEqual(['withdrawn']);

    // 7. The first order's pieces are made and finished: the order is ready; staff ship it with a
    // tracking number, Luna is told and sees it, and staff mark it delivered.
    const photo = (await measuredDesign(prisma, tenant.id, staffUser.id, { status: 'uploaded', measures: [] })).versionId;
    const answers: Record<string, object> = {
      polishing: { answers: [{ item: 'surface', value: 'ok' }] },
      final_qc: { answers: [{ item: 'dimensions', value: true }], photo_file_version_ids: [photo] },
    };
    const rings10 = await pieceIds(firstGroup);
    for (const at_step of ['print_pattern', 'casting_tree', 'casting', 'polishing', 'final_qc', 'packing']) {
      await staff.post('/workflow/moves', { work_order_ids: rings10, kind: 'pass', at_step, ...(answers[at_step] ?? {}) }).expect(200);
    }
    expect((await staffView(first.id)).state).toBe('ready');
    const shipped = (await staff.post(`/orders/${first.id}/ship`, { courier: 'Parcel Express', tracking: 'PX123456' }).expect(200)).body as Order;
    expect(shipped.state).toBe('shipped');
    const told = await prisma.inTenant(tenant.id, (tx) => tx.notification.count({ where: { eventKey: 'order.shipped' } }));
    expect(told).toBeGreaterThan(0);
    const seen = (await ben.get(`${portal}/orders/${first.id}`).expect(200)).body as Order;
    expect(seen).toMatchObject({ state: 'shipped', shipping: { courier: 'Parcel Express', tracking: 'PX123456' } });
    expect(((await staff.post(`/orders/${first.id}/deliver`).expect(200)).body as Order).state).toBe('delivered');

    // 5 (last, as it suspends Northcast). Luna, allowed to pick, orders two lines at Northcast: both
    // are Northcast's direct jobs at once.
    await staff.patch(`/customers/${luna}`, { may_pick_partner: true }).expect(200);
    const picked = (await order([(await castQuote({ partner_id: ids.northcast })).id, (await castQuote({ partner_id: ids.northcast, quantity: 2 })).id]).expect(201))
      .body as Order;
    for (const line of (await staffView(picked.id)).lines) {
      expect(line.partner?.id).toBe(ids.northcast);
      const history = (await staff.get(`/partners/jobs/${line.group_id}`).expect(200)).body as { data: { kind: string; status: string }[] };
      expect(history.data).toEqual([expect.objectContaining({ kind: 'direct', status: 'accepted' })]);
    }

    // With `splitOrderLines` off, a part picked at Northcast and a print picked at Layerline can't be one order.
    await staff.put('/settings/partners.routing', { offerHours: 24, splitOrderLines: false }).expect(200);
    await staff.patch(`/partners/${ids.layerline}/limits`, { accepts_direct_orders: true }).expect(200);
    const resinDesign = (await measuredDesign(prisma, tenant.id, me.user.id, { customerId: luna })).versionId;
    const print = (
      (
        await ben
          .post(`${portal}/quotes`, {
            product_id: ids.resinPrint,
            options: { material: 'resin_standard', finish: 'polished' },
            size: { scale: '1' },
            quantity: 5,
            file_version_id: resinDesign,
            delivery_speed: 'standard',
            partner_id: ids.layerline,
          })
          .expect(201)
      ).body as { quote: Quote }
    ).quote;
    const atNorthcast = await castQuote({ partner_id: ids.northcast });
    let before = await counts();
    const split = (await order([atNorthcast.id, print.id]).expect(409)).body as { errors: { path: string }[] };
    expect(split.errors.map((error) => error.path)).toEqual(['lines.1']);
    expect(await counts()).toEqual(before);

    // With Northcast suspended, an order picked there is refused whole, and nothing is created.
    await staff.post(`/partners/${ids.northcast}/suspend`).expect(200);
    before = await counts();
    await order([(await castQuote()).id, atNorthcast.id]).expect(409);
    expect(await counts()).toEqual(before);
  });
});
