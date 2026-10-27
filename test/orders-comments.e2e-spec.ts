import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { customerOrderCommentResponseSchema, orderCommentResponseSchema } from '../src/modules/orders/order-response';
import { partnerJobCommentResponseSchema } from '../src/modules/partners/partner-response';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Line {
  id: string;
  group_id: string;
}
interface Order {
  id: string;
  lines: Line[];
}
interface StaffComment {
  id: string;
  line_id: string | null;
  author: { kind: string; id: string; name: string };
  for_partner: boolean;
  body: string;
  attachments: { file_version_id: string; name: string }[];
}
interface CustomerComment {
  id: string;
  line_id: string | null;
  author: { kind: string; name: string };
  body: string;
  attachments: { file_version_id: string; name: string }[];
}
interface PartnerComment {
  id: string;
  author: { kind: string; name: string | null };
  body: string;
  attachments: { file_version_id: string; name: string }[];
}

/**
 * Comments on orders (Orders spec, goal 13; Orders 2 plan, Task 7): staff and the customer's people write
 * on an order or a line, with attachments; a partner holding a line reads only the comments staff mark for
 * it and writes text of its own. Never the customer, the order, other lines, or a comment not marked for it.
 */
describe('orders: comments', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  // Feed snapshots are platform-wide and outlive test runs; a metal of this run's own has none, so silver is at its fallback.
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  /** A named person written straight to the database, of `kind`, with a membership in an organisation. */
  async function person(tenantId: string, name: string, kind: 'customer' | 'partner', organisationId: string, role: string) {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind, name } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: kind, organisationId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  }

  /**
   * The priced cast part; CastCo and MetalWorks, each able to make the whole cast line, each with a member
   * (Carl, Mia); Luna Jewels with a buyer (Ben) and a viewer, Sol Studio with a buyer; staff (Ana); and
   * Luna's order of two lines, line 0 accepted by CastCo and line 1 offered to MetalWorks.
   */
  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    await prisma.inTenant(tenant.id, (tx) => tx.user.update({ where: { id: owner.id }, data: { name: 'Ana' } }));
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    const { printPattern, castingTree, casting, polishing } = cast.steps;
    const { finalQc, packing } = cast.workflow.notPriced;
    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;

    const workshop = async (name: string, member: string) => {
      const id = ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
      await staff
        .put(`/partners/${id}/capabilities`, {
          capabilities: [printPattern, castingTree, casting, polishing, finalQc, packing].map((step_type_id) => ({
            step_type_id,
            capacity: 200,
            capacity_period: 'week',
          })),
        })
        .expect(200);
      await staff.put(`/partners/${id}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
      await staff.post(`/partners/${id}/prices/copy-from-workspace`).expect(200);
      await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
      await staff.post(`/partners/${id}/approve`).expect(200);
      return { id, person: await person(tenant.id, member, 'partner', id, 'member') };
    };
    const castco = await workshop('CastCo', 'Carl');
    const metalworks = await workshop('MetalWorks', 'Mia');

    const customer = async (name: string) => ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
    const luna = await customer('Luna Jewels');
    const sol = await customer('Sol Studio');

    const quote = async (quantity: number) =>
      ((
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
    const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
    const place = async (quantities: number[]) => {
      const lines = [];
      for (const quantity of quantities) lines.push({ quote_id: (await quote(quantity)).id });
      return (await staff.post('/orders', { customer_id: luna, lines, address, shipping_method: 'courier' }).expect(201)).body as Order;
    };
    const placed = await place([10, 2]);
    await staff.post(`/partners/jobs/${placed.lines[0].group_id}/offer`, { partner_id: castco.id }).expect(201);
    await castco.person.post(`/partner-portal/partners/${castco.id}/jobs/${placed.lines[0].group_id}/accept`).expect(200);
    await staff.post(`/partners/jobs/${placed.lines[1].group_id}/offer`, { partner_id: metalworks.id }).expect(201);

    return {
      id: tenant.id,
      owner: owner.id,
      staff,
      castco,
      metalworks,
      luna,
      sol,
      place,
      order: placed,
      buyer: await person(tenant.id, 'Ben', 'customer', luna, 'buyer'),
      viewer: await person(tenant.id, 'Vera', 'customer', luna, 'viewer'),
      solBuyer: await person(tenant.id, 'Sam', 'customer', sol, 'buyer'),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** A file version written to the database: uploaded unless told otherwise, the customer's own when given one. */
  const upload = async (tenant: Tenant, options: { status?: string; customerId?: string } = {}) =>
    (await measuredDesign(prisma, tenant.id, tenant.owner, { status: options.status ?? 'uploaded', measures: [], customerId: options.customerId })).versionId;

  const staffPath = (tenant: Tenant) => `/orders/${tenant.order.id}/comments`;
  const customerPath = (tenant: Tenant, customerId = tenant.luna) => `/portal/customers/${customerId}/orders/${tenant.order.id}/comments`;
  const jobPath = (tenant: Tenant, workshop: Tenant['castco'], line = 0) =>
    `/partner-portal/partners/${workshop.id}/jobs/${tenant.order.lines[line].group_id}/comments`;
  const list = <T>(response: request.Response) => (response.body as { data: T[]; next_cursor: string | null }).data;

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

  it('lets staff and the customer talk on the order', async () => {
    const tenant = await freshTenant();
    const file = await upload(tenant);

    const asked = await tenant.buyer.post(customerPath(tenant), { body: 'Can the clasp be gold?' }).expect(201);
    expectDocumented(customerOrderCommentResponseSchema, asked.body);
    expect(asked.body).toMatchObject({ line_id: null, author: { kind: 'customer', name: 'Ben' }, body: 'Can the clasp be gold?', attachments: [] });

    const answered = await tenant.staff
      .post(staffPath(tenant), { body: 'Yes, see the sketch', line_id: tenant.order.lines[0].id, attachments: [file] })
      .expect(201);
    expectDocumented(orderCommentResponseSchema, answered.body);
    expect(answered.body).toMatchObject({
      line_id: tenant.order.lines[0].id,
      author: { kind: 'staff', id: tenant.owner, name: 'Ana' },
      for_partner: false,
      body: 'Yes, see the sketch',
      attachments: [{ file_version_id: file, name: 'part.stl' }],
    });

    // Both read both, oldest first.
    const staffSees = await tenant.staff.get(staffPath(tenant)).expect(200);
    expectDocumented(pageSchema(orderCommentResponseSchema), staffSees.body);
    expect(list<StaffComment>(staffSees).map((comment) => [comment.author.kind, comment.body])).toEqual([
      ['customer', 'Can the clasp be gold?'],
      ['staff', 'Yes, see the sketch'],
    ]);
    for (const reader of [tenant.buyer, tenant.viewer]) {
      const customerSees = await reader.get(customerPath(tenant)).expect(200);
      expectDocumented(pageSchema(customerOrderCommentResponseSchema), customerSees.body);
      expect(list<CustomerComment>(customerSees).map((comment) => [comment.author.kind, comment.author.name, comment.body])).toEqual([
        ['customer', 'Ben', 'Can the clasp be gold?'],
        ['staff', 'Ana', 'Yes, see the sketch'],
      ]);
      // The customer never sees the staff-only flag.
      expect(customerSees.text).not.toContain('for_partner');
    }

    // A page at a time.
    const first = await tenant.staff.get(`${staffPath(tenant)}?limit=1`).expect(200);
    expect(list<StaffComment>(first).map((comment) => comment.body)).toEqual(['Can the clasp be gold?']);
    const next = (first.body as { next_cursor: string }).next_cursor;
    expect(next).toEqual(expect.any(String));
    expect(list<StaffComment>(await tenant.staff.get(`${staffPath(tenant)}?limit=1&cursor=${next}`).expect(200)).map((comment) => comment.body)).toEqual([
      'Yes, see the sketch',
    ]);
  });

  it('shows the partner only what staff mark for it, on its own line', async () => {
    const tenant = await freshTenant();
    const [zero, one] = tenant.order.lines;
    const post = (body: object) => tenant.staff.post(staffPath(tenant), body).expect(201);
    await post({ body: 'Polish the back harder', line_id: zero.id, for_partner: true });
    await post({ body: 'Delivery date moved for Luna', line_id: zero.id });
    await post({ body: 'Pack in the grey box', line_id: one.id, for_partner: true });

    // CastCo reads the first only, and answers.
    let seen = await tenant.castco.person.get(jobPath(tenant, tenant.castco)).expect(200);
    expectDocumented(pageSchema(partnerJobCommentResponseSchema), seen.body);
    expect(list<PartnerComment>(seen).map((comment) => [comment.author.kind, comment.author.name, comment.body])).toEqual([
      ['workspace', null, 'Polish the back harder'],
    ]);
    const reply = await tenant.castco.person.post(jobPath(tenant, tenant.castco), { body: 'Will do' }).expect(201);
    expectDocumented(partnerJobCommentResponseSchema, reply.body);
    expect(reply.body).toMatchObject({ author: { kind: 'partner', name: 'Carl' }, body: 'Will do', attachments: [] });

    seen = await tenant.castco.person.get(jobPath(tenant, tenant.castco)).expect(200);
    expect(list<PartnerComment>(seen).map((comment) => comment.body)).toEqual(['Polish the back harder', 'Will do']);
    // Never the customer, the order, another line or a comment it wasn't sent.
    for (const secret of ['Luna', tenant.order.id, tenant.order.lines[0].id, 'Delivery date', 'grey box', 'for_partner']) {
      expect({ secret, found: seen.text.includes(secret) }).toEqual({ secret, found: false });
    }

    // MetalWorks has only been offered line 1: not found, to read or to write.
    await tenant.metalworks.person.get(jobPath(tenant, tenant.metalworks, 1)).expect(404);
    await tenant.metalworks.person.post(jobPath(tenant, tenant.metalworks, 1), { body: 'Not yet mine' }).expect(404);
    // Another partner's job is not found either.
    await tenant.metalworks.person.get(jobPath(tenant, tenant.castco)).expect(404);

    // Once line 0 moves to MetalWorks, CastCo has no job to read or write on; MetalWorks sees what staff sent,
    // not CastCo's own words.
    await tenant.staff.post(`/partners/jobs/${zero.group_id}/reassign`, { partner_id: tenant.metalworks.id }).expect(201);
    await tenant.castco.person.get(jobPath(tenant, tenant.castco)).expect(404);
    await tenant.castco.person.post(jobPath(tenant, tenant.castco), { body: 'Still here?' }).expect(404);
    const moved = await tenant.metalworks.person.get(jobPath(tenant, tenant.metalworks)).expect(200);
    expect(list<PartnerComment>(moved).map((comment) => comment.body)).toEqual(['Polish the back harder']);
  });

  it('keeps partner comments and comments for the partner from the customer', async () => {
    const tenant = await freshTenant();
    const zero = tenant.order.lines[0];
    await tenant.staff.post(staffPath(tenant), { body: 'Polish the back harder', line_id: zero.id, for_partner: true }).expect(201);
    await tenant.staff.post(staffPath(tenant), { body: 'Your order is in production' }).expect(201);
    await tenant.castco.person.post(jobPath(tenant, tenant.castco), { body: 'Casting tomorrow' }).expect(201);
    await tenant.buyer.post(customerPath(tenant), { body: 'Thank you' }).expect(201);

    const customerSees = await tenant.buyer.get(customerPath(tenant)).expect(200);
    expect(list<CustomerComment>(customerSees).map((comment) => comment.body)).toEqual(['Your order is in production', 'Thank you']);
    for (const secret of ['Polish the back', 'Casting tomorrow', 'CastCo', 'Carl']) {
      expect({ secret, found: customerSees.text.includes(secret) }).toEqual({ secret, found: false });
    }

    // Staff read everything, with who wrote it and whether the partner sees it.
    const staffSees = list<StaffComment>(await tenant.staff.get(staffPath(tenant)).expect(200));
    expect(staffSees.map((comment) => [comment.author.kind, comment.for_partner, comment.body])).toEqual([
      ['staff', true, 'Polish the back harder'],
      ['staff', false, 'Your order is in production'],
      ['partner', false, 'Casting tomorrow'],
      ['customer', false, 'Thank you'],
    ]);
    // A partner's comment is on the line it holds.
    expect(staffSees[2]).toMatchObject({ line_id: zero.id, author: { name: 'Carl' } });
  });

  it('refuses attachments the author may not use, and links to ones the reader may not see', async () => {
    const tenant = await freshTenant();
    const zero = tenant.order.lines[0];
    const sols = await upload(tenant, { customerId: tenant.sol });
    const lunas = await upload(tenant, { customerId: tenant.luna });
    const workspaces = await upload(tenant);
    const notUploaded = await upload(tenant, { status: 'pending', customerId: tenant.luna });

    // A customer attaches only its own uploaded files.
    for (const file of [sols, workspaces, notUploaded]) {
      const refused = await tenant.buyer.post(customerPath(tenant), { body: 'See attached', attachments: [file] }).expect(404);
      expect((refused.body as { errors: { path: string }[] }).errors[0].path).toBe('attachments.0');
    }
    await tenant.buyer.post(customerPath(tenant), { body: 'See attached', attachments: [lunas, sols] }).expect(404);
    // Staff attach files of the workspace, but not one that isn't uploaded; nothing was saved by a refusal.
    const staffRefused = await tenant.staff.post(staffPath(tenant), { body: 'See attached', attachments: [notUploaded] }).expect(404);
    expect((staffRefused.body as { errors: { path: string }[] }).errors[0].path).toBe('attachments.0');
    expect(list<StaffComment>(await tenant.staff.get(staffPath(tenant)).expect(200))).toEqual([]);

    const mine = (await tenant.buyer.post(customerPath(tenant), { body: 'My sketch', attachments: [lunas] }).expect(201)).body as CustomerComment;
    const forPartner = (
      await tenant.staff.post(staffPath(tenant), { body: 'Match this', line_id: zero.id, for_partner: true, attachments: [workspaces] }).expect(201)
    ).body as StaffComment;
    const link = (path: string, comment: string, file: string) => `${path}/${comment}/attachments/${file}/url`;

    // Ben downloads his own attachment, and not the one on a comment for the partner.
    const own = await tenant.buyer.get(link(customerPath(tenant), mine.id, lunas)).expect(200);
    expect(own.body).toEqual({ url: expect.any(String), expires_at: expect.any(String) });
    await tenant.buyer.get(link(customerPath(tenant), forPartner.id, workspaces)).expect(404);
    // Nor another file by naming it under his own comment.
    await tenant.buyer.get(link(customerPath(tenant), mine.id, workspaces)).expect(404);
    await tenant.solBuyer.get(link(customerPath(tenant, tenant.sol), mine.id, lunas)).expect(404);

    // CastCo downloads what was sent to it, and not the customer's sketch; staff both.
    await tenant.castco.person.get(link(jobPath(tenant, tenant.castco), forPartner.id, workspaces)).expect(200);
    await tenant.castco.person.get(link(jobPath(tenant, tenant.castco), mine.id, lunas)).expect(404);
    await tenant.metalworks.person.get(link(jobPath(tenant, tenant.metalworks, 1), forPartner.id, workspaces)).expect(404);
    await tenant.staff.get(link(staffPath(tenant), mine.id, lunas)).expect(200);
    await tenant.staff.get(link(staffPath(tenant), forPartner.id, workspaces)).expect(200);
  });

  it('refuses who may not write, and what is malformed', async () => {
    const tenant = await freshTenant();
    const zero = tenant.order.lines[0];
    const other = await tenant.place([1]);
    const comment = { body: 'Hello' };

    // A viewer reads but doesn't write; another customer's people don't find the order.
    await tenant.viewer.post(customerPath(tenant), comment).expect(403);
    await tenant.solBuyer.post(customerPath(tenant, tenant.sol), comment).expect(404);
    await tenant.solBuyer.get(customerPath(tenant, tenant.sol)).expect(404);
    await tenant.solBuyer.post(customerPath(tenant), comment).expect(404);

    // The partner flag belongs to staff, and to a comment on a line.
    await tenant.buyer.post(customerPath(tenant), { ...comment, line_id: zero.id, for_partner: true }).expect(400);
    await tenant.staff.post(staffPath(tenant), { ...comment, for_partner: true }).expect(400);
    // A line of another order.
    await tenant.staff.post(staffPath(tenant), { ...comment, line_id: other.lines[0].id }).expect(400);
    await tenant.buyer.post(customerPath(tenant), { ...comment, line_id: other.lines[0].id }).expect(400);
    // A partner writes text only.
    await tenant.castco.person.post(jobPath(tenant, tenant.castco), { ...comment, attachments: [] }).expect(400);

    // Length: 1 to 5000 characters, at most 10 attachments.
    await tenant.staff.post(staffPath(tenant), { body: 'x'.repeat(5001) }).expect(400);
    await tenant.staff.post(staffPath(tenant), { body: '' }).expect(400);
    await tenant.staff.post(staffPath(tenant), { body: 'x'.repeat(5000) }).expect(201);
    const files = Array.from({ length: 11 }, () => '0190a1b2-0000-7000-8000-000000000000');
    await tenant.staff.post(staffPath(tenant), { ...comment, attachments: files }).expect(400);
    await tenant.buyer.post(customerPath(tenant), { ...comment, attachments: files }).expect(400);
    await tenant.staff.get('/orders/0190a1b2-0000-7000-8000-000000000000/comments').expect(404);
  });
});
