import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { workingDaysBefore } from '../src/modules/orders/dates';
import type { BusinessCalendar } from '../src/modules/orders/dates';
import { jobAssignmentResponseSchema, partnerJobDetailResponseSchema } from '../src/modules/partners/partner-response';
import { pricedAssembly } from './assembly-fixtures';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface Part {
  position: number;
  group_id: string;
}
interface Line {
  group_id: string;
  parts: Part[];
}
interface Order {
  id: string;
  promised_on: string;
  lines: Line[];
}
interface Assignment {
  status: string;
  due_on: string | null;
}

/**
 * Due dates on partner jobs (Orders spec, B3; Orders 2 plan, Task 5): a job offered without a date is due
 * the order's promised date less a buffer of working days, a part one allowance day sooner, never before
 * today. Staff may give a date. A moved job keeps its date; a job that isn't an order line has none.
 */
describe('orders: due dates on partner jobs', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none, so silver is at its fallback.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  // Test workspaces run in UTC; the calendar is set so the dates below are the same on every day of the week.
  const calendar: BusinessCalendar = { workingDays: [1, 2, 3, 4, 5], endHour: 17, closedDates: [] };
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  /** A person written straight to the database, of `kind`, with a membership in an organisation. */
  async function person(tenantId: string, kind: 'customer' | 'partner', organisationId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: kind, organisationId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /**
   * The pendant set and the cast part, `courier`, a Monday–Friday calendar, standard delivery in 10 working
   * days and rush in 2, CastCo and MetalWorks (each able to make every step, taking direct orders, each with
   * a member), and Luna Jewels, who may pick a workshop, with a buyer.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const set = await pricedAssembly(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    await staff.patch(`/catalog/products/${set.cast.productId}`, { published: true }).expect(200);
    const { printPattern, castingTree, casting, polishing } = set.cast.steps;
    const { finalQc, packing } = set.cast.workflow.notPriced;
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    await staff.put('/settings/business.calendar', { ...calendar, startHour: 9 }).expect(200);
    const speeds = ((await staff.get('/pricing/delivery-speeds').expect(200)).body as { data: { id: string; key: string }[] }).data;
    for (const [key, working_days] of [['standard', 10], ['rush', 2]] as const) {
      await staff.patch(`/pricing/delivery-speeds/${speeds.find((speed) => speed.key === key)!.id}`, { working_days }).expect(200);
    }
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;

    const workshop = async (name: string) => {
      const id = ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
      await staff
        .put(`/partners/${id}/capabilities`, {
          capabilities: [printPattern, castingTree, casting, polishing, set.steps.print, finalQc, packing].map((step_type_id) => ({
            step_type_id,
            capacity: 500,
            capacity_period: 'week',
          })),
        })
        .expect(200);
      await staff.put(`/partners/${id}/offerings`, { option_value_ids: [set.cast.v.silver, set.cast.v.polished] }).expect(200);
      await staff.post(`/partners/${id}/prices/copy-from-workspace`).expect(200);
      await staff.patch(`/partners/${id}/limits`, { accepts_direct_orders: true }).expect(200);
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return { id, person: await person(tenant.id, 'partner', id, 'member') };
    };

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    await staff.patch(`/customers/${luna}`, { may_pick_partner: true }).expect(200);
    const design = (await measuredDesign(prisma, tenant.id, owner.id, { customerId: luna })).versionId;
    return {
      id: tenant.id,
      staff,
      buyer: await person(tenant.id, 'customer', luna, 'buyer'),
      luna,
      design,
      castco: await workshop('CastCo'),
      metalworks: await workshop('MetalWorks'),
      ...set,
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
  /** A cast part quote for Luna at the workspace's own prices, on a delivery speed. */
  const castQuote = async (tenant: Tenant, delivery_speed = 'standard') =>
    ((
      await tenant.staff
        .post('/pricing/quotes', {
          product_id: tenant.cast.productId,
          options: { material: 'silver_925', finish: 'polished' },
          size: { scale: '1.5' },
          quantity: 5,
          file_version_id: tenant.cast.versionId,
          customer_id: tenant.luna,
          delivery_speed,
        })
        .expect(201)
    ).body as { quote: { id: string } }).quote;
  const setQuote = async (tenant: Tenant) =>
    ((
      await tenant.staff
        .post('/pricing/quotes', {
          product_id: tenant.set,
          options: { material: 'silver_925', finish: 'polished' },
          quantity: 2,
          customer_id: tenant.luna,
        })
        .expect(201)
    ).body as { quote: { id: string } }).quote;
  const order = async (tenant: Tenant, quoteIds: string[]) =>
    (
      await tenant.staff
        .post('/orders', { customer_id: tenant.luna, lines: quoteIds.map((quote_id) => ({ quote_id })), address, shipping_method: 'courier' })
        .expect(201)
    ).body as Order;
  const offer = (tenant: Tenant, groupId: string, partnerId: string, extra: object = {}) =>
    tenant.staff.post(`/partners/jobs/${groupId}/offer`, { partner_id: partnerId, ...extra });
  const scheduling = (tenant: Tenant, bufferDays: number, assemblyAllowanceDays = 1) =>
    tenant.staff.put('/settings/orders.scheduling', { bufferDays, assemblyAllowanceDays }).expect(200);
  const history = async (tenant: Tenant, groupId: string) =>
    ((await tenant.staff.get(`/partners/jobs/${groupId}`).expect(200)).body as { data: Assignment[] }).data;

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
    await app.close();
  });

  it('offers a line due the promised date less the buffer, and shows it to the partner', async () => {
    const tenant = await freshTenant();
    const placed = await order(tenant, [(await castQuote(tenant)).id]);
    const dueOn = workingDaysBefore(placed.promised_on, 2, calendar);
    expect(dueOn < placed.promised_on).toBe(true);

    const offered = await offer(tenant, placed.lines[0].group_id, tenant.castco.id).expect(201);
    expectDocumented(jobAssignmentResponseSchema, offered.body);
    expect((offered.body as Assignment).due_on).toBe(dueOn);
    expect((await history(tenant, placed.lines[0].group_id))[0].due_on).toBe(dueOn);

    // The partner sees the date and still nothing of the order or the customer.
    const portal = `/partner-portal/partners/${tenant.castco.id}/jobs`;
    const detail = await tenant.castco.person.get(`${portal}/${placed.lines[0].group_id}`).expect(200);
    expectDocumented(partnerJobDetailResponseSchema, detail.body);
    expect(detail.body).toMatchObject({ due_on: dueOn });
    const listed = await tenant.castco.person.get(portal).expect(200);
    expect((listed.body as { data: { due_on: string }[] }).data.map((job) => job.due_on)).toEqual([dueOn]);
    for (const text of [detail.text, listed.text]) {
      expect(text).not.toContain('Luna');
      expect(text).not.toContain(placed.id);
      expect(text).not.toContain(placed.promised_on);
    }
  });

  it('takes the due date staff give, and refuses one before today', async () => {
    const tenant = await freshTenant();
    const placed = await order(tenant, [(await castQuote(tenant)).id, (await castQuote(tenant)).id]);

    const given = await offer(tenant, placed.lines[0].group_id, tenant.castco.id, { due_on: day(1) }).expect(201);
    expect((given.body as Assignment).due_on).toBe(day(1));
    await offer(tenant, placed.lines[1].group_id, tenant.castco.id, { due_on: day(-1) }).expect(400);
    expect(await history(tenant, placed.lines[1].group_id)).toEqual([]);
    // Today itself is allowed.
    await offer(tenant, placed.lines[1].group_id, tenant.castco.id, { due_on: day(0) }).expect(201);
  });

  it('is due no earlier than today when the promised date is near', async () => {
    const tenant = await freshTenant();
    await scheduling(tenant, 5);
    const placed = await order(tenant, [(await castQuote(tenant, 'rush')).id]);
    // Two working days away, less five: the date would be before today.
    expect(workingDaysBefore(placed.promised_on, 5, calendar) < day(0)).toBe(true);

    const offered = await offer(tenant, placed.lines[0].group_id, tenant.castco.id).expect(201);
    expect((offered.body as Assignment).due_on).toBe(day(0));
  });

  it("gives a picked workshop's direct job the default, and a part one more allowance day", async () => {
    const tenant = await freshTenant();
    await scheduling(tenant, 2, 1);

    // Luna picks CastCo in the customer app: the job starts with the order, accepted.
    const picked = (
      await tenant.buyer
        .post(`/portal/customers/${tenant.luna}/quotes`, {
          product_id: tenant.cast.productId,
          options: { material: 'silver_925', finish: 'polished' },
          size: { scale: '1.5' },
          quantity: 5,
          file_version_id: tenant.design,
          partner_id: tenant.castco.id,
        })
        .expect(201)
    ).body as { quote: { id: string } };
    const direct = await order(tenant, [picked.quote.id]);
    expect((await history(tenant, direct.lines[0].group_id)).map((row) => [row.status, row.due_on])).toEqual([
      ['accepted', workingDaysBefore(direct.promised_on, 2, calendar)],
    ]);

    // A part is due one working day sooner than a line of the same order would be.
    const placed = await order(tenant, [(await setQuote(tenant)).id]);
    const [pendant, bail] = placed.lines[0].parts;
    const sooner = workingDaysBefore(placed.promised_on, 3, calendar);
    expect(sooner < workingDaysBefore(placed.promised_on, 2, calendar)).toBe(true);
    expect(((await offer(tenant, pendant.group_id, tenant.castco.id).expect(201)).body as Assignment).due_on).toBe(sooner);
    expect(((await offer(tenant, bail.group_id, tenant.metalworks.id).expect(201)).body as Assignment).due_on).toBe(sooner);
  });

  it('keeps the due date when the job moves to another partner', async () => {
    const tenant = await freshTenant();
    const placed = await order(tenant, [(await castQuote(tenant)).id]);
    const { group_id } = placed.lines[0];
    await offer(tenant, group_id, tenant.castco.id, { due_on: day(3) }).expect(201);
    await tenant.castco.person.post(`/partner-portal/partners/${tenant.castco.id}/jobs/${group_id}/accept`).expect(200);

    const moved = await tenant.staff.post(`/partners/jobs/${group_id}/reassign`, { partner_id: tenant.metalworks.id }).expect(201);
    expect((moved.body as Assignment).due_on).toBe(day(3));
    expect((await history(tenant, group_id)).map((row) => [row.status, row.due_on]).sort()).toEqual([
      ['accepted', day(3)],
      ['replaced', day(3)],
    ]);
  });

  it('gives a job that is not an order line no due date, unless staff give one', async () => {
    const tenant = await freshTenant();
    const bare = async () => {
      const quote = await castQuote(tenant);
      return ((await tenant.staff.post('/workflow/groups', { quote_id: quote.id }).expect(201)).body as { id: string }).id;
    };
    const [first, second] = [await bare(), await bare()];

    const offered = await offer(tenant, first, tenant.castco.id).expect(201);
    expect((offered.body as Assignment).due_on).toBeNull();
    const dated = await offer(tenant, second, tenant.castco.id, { due_on: day(2) }).expect(201);
    expect((dated.body as Assignment).due_on).toBe(day(2));
    const detail = await tenant.castco.person.get(`/partner-portal/partners/${tenant.castco.id}/jobs/${first}`).expect(200);
    expect((detail.body as { due_on: string | null }).due_on).toBeNull();
  });
});
