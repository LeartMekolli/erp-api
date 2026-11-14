import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { orderCommentResponseSchema, readersChangedResponseSchema } from '../src/modules/orders/order-response';
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
  partner: { id: string; name: string } | null;
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
 * Comments on orders, between staff and the partners making the lines: staff write on an order or a line,
 * with attachments, and where decides who reads it. A partner holding a line reads only what staff wrote on
 * it while it held it, and writes text of its own. Never the order, other lines, or the customer, which
 * neither reads nor writes comments.
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
    return { id: user.id, ...as((await tokens.issueForUser(tenantId, user.id)).accessToken) };
  }

  /**
   * The priced cast part; CastCo and MetalWorks, each able to make the whole cast line, each with a member
   * (Carl, Mia); Luna Jewels with a buyer (Ben); staff (Ana); and Luna's order of two lines, line 0
   * accepted by CastCo and line 1 offered to MetalWorks.
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

    /** Pays later, so an order starts at once instead of waiting for payment. */
    const customer = async (name: string) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      await staff.put(`/customers/${id}/payment-terms`, { terms: 'pay_later' }).expect(200);
      return id;
    };
    const luna = await customer('Luna Jewels');

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
      place,
      order: placed,
      buyer: await person(tenant.id, 'Ben', 'customer', luna, 'buyer'),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** A file version written to the database, uploaded unless told otherwise. */
  const upload = async (tenant: Tenant, status = 'uploaded') => (await measuredDesign(prisma, tenant.id, tenant.owner, { status, measures: [] })).versionId;

  const staffPath = (tenant: Tenant) => `/orders/${tenant.order.id}/comments`;
  const customerPath = (tenant: Tenant) => `/portal/customers/${tenant.luna}/orders/${tenant.order.id}/comments`;
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

  it('keeps comments on the order for staff, a page at a time', async () => {
    const tenant = await freshTenant();
    const file = await upload(tenant);

    const noted = await tenant.staff.post(staffPath(tenant), { body: 'Luna wants it before Friday', attachments: [file] }).expect(201);
    expectDocumented(orderCommentResponseSchema, noted.body);
    expect(noted.body).toMatchObject({
      line_id: null,
      author: { kind: 'staff', id: tenant.owner, name: 'Ana' },
      partner: null,
      body: 'Luna wants it before Friday',
      attachments: [{ file_version_id: file, name: 'part.stl' }],
    });
    await tenant.staff.post(staffPath(tenant), { body: 'Courier booked' }).expect(201);

    // Oldest first, a page at a time.
    const staffSees = await tenant.staff.get(staffPath(tenant)).expect(200);
    expectDocumented(pageSchema(orderCommentResponseSchema), staffSees.body);
    expect(list<StaffComment>(staffSees).map((comment) => comment.body)).toEqual(['Luna wants it before Friday', 'Courier booked']);
    const first = await tenant.staff.get(`${staffPath(tenant)}?limit=1`).expect(200);
    expect(list<StaffComment>(first).map((comment) => comment.body)).toEqual(['Luna wants it before Friday']);
    const next = (first.body as { next_cursor: string }).next_cursor;
    expect(next).toEqual(expect.any(String));
    expect(list<StaffComment>(await tenant.staff.get(`${staffPath(tenant)}?limit=1&cursor=${next}`).expect(200)).map((comment) => comment.body)).toEqual([
      'Courier booked',
    ]);

    // The partner holding a line reads none of it, nor downloads its file.
    const castco = jobPath(tenant, tenant.castco);
    expect(list<PartnerComment>(await tenant.castco.person.get(castco).expect(200))).toEqual([]);
    await tenant.castco.person.get(`${castco}/${(noted.body as StaffComment).id}/attachments/${file}/url`).expect(404);
    await tenant.staff.get(`${staffPath(tenant)}/${(noted.body as StaffComment).id}/attachments/${file}/url`).expect(200);
  });

  it('shares a comment on a line with the partner that has accepted it, and nobody else', async () => {
    const tenant = await freshTenant();
    const [zero, one] = tenant.order.lines;
    const post = (body: object) => tenant.staff.post(staffPath(tenant), body).expect(201);
    const sent = (await post({ body: 'Polish the back harder', line_id: zero.id })).body as StaffComment;
    expectDocumented(orderCommentResponseSchema, sent);
    expect(sent.partner).toEqual({ id: tenant.castco.id, name: 'CastCo' });
    await post({ body: 'Delivery date moved for Luna' });
    // Line 1 is only offered to MetalWorks: a comment there is for staff alone.
    const notAccepted = (await post({ body: 'Pack in the grey box', line_id: one.id })).body as StaffComment;
    expect(notAccepted).toMatchObject({ line_id: one.id, partner: null });

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
    // Never the customer, the order, another line or a comment on either.
    for (const secret of ['Luna', tenant.order.id, tenant.order.lines[0].id, 'Delivery date', 'grey box']) {
      expect({ secret, found: seen.text.includes(secret) }).toEqual({ secret, found: false });
    }

    // Staff see which partner reads each comment.
    const staffSees = list<StaffComment>(await tenant.staff.get(staffPath(tenant)).expect(200));
    expect(staffSees.map((comment) => [comment.author.kind, comment.partner?.name ?? null, comment.body])).toEqual([
      ['staff', 'CastCo', 'Polish the back harder'],
      ['staff', null, 'Delivery date moved for Luna'],
      ['staff', null, 'Pack in the grey box'],
      ['partner', 'CastCo', 'Will do'],
    ]);
    expect(staffSees[3]).toMatchObject({ line_id: zero.id, author: { name: 'Carl' } });

    // MetalWorks has only been offered line 1: not found, to read or to write.
    await tenant.metalworks.person.get(jobPath(tenant, tenant.metalworks, 1)).expect(404);
    await tenant.metalworks.person.post(jobPath(tenant, tenant.metalworks, 1), { body: 'Not yet mine' }).expect(404);
    // Another partner's job is not found either.
    await tenant.metalworks.person.get(jobPath(tenant, tenant.castco)).expect(404);

    // Once line 0 moves to MetalWorks, CastCo has no job to read or write on. MetalWorks reads only what staff
    // write on the line from then on: neither what was said with CastCo nor CastCo's own words.
    await tenant.staff.post(`/partners/jobs/${zero.group_id}/reassign`, { partner_id: tenant.metalworks.id }).expect(201);
    await tenant.castco.person.get(jobPath(tenant, tenant.castco)).expect(404);
    await tenant.castco.person.post(jobPath(tenant, tenant.castco), { body: 'Still here?' }).expect(404);
    expect(list<PartnerComment>(await tenant.metalworks.person.get(jobPath(tenant, tenant.metalworks)).expect(200))).toEqual([]);
    const handedOver = (await post({ body: 'Start from the cast tree', line_id: zero.id })).body as StaffComment;
    expect(handedOver.partner).toEqual({ id: tenant.metalworks.id, name: 'MetalWorks' });
    const moved = await tenant.metalworks.person.get(jobPath(tenant, tenant.metalworks)).expect(200);
    expect(list<PartnerComment>(moved).map((comment) => comment.body)).toEqual(['Start from the cast tree']);
    for (const secret of ['Polish the back', 'Will do']) {
      expect({ secret, found: moved.text.includes(secret) }).toEqual({ secret, found: false });
    }
  });

  it('saves nothing when the comment would reach other readers than staff were told', async () => {
    const tenant = await freshTenant();
    const [zero, one] = tenant.order.lines;
    const post = (body: object) => tenant.staff.post(staffPath(tenant), body);

    // Told rightly, it saves as before.
    expect((await post({ body: 'Polish the back harder', line_id: zero.id, readers: tenant.castco.id }).expect(201)).body).toMatchObject({
      partner: { id: tenant.castco.id, name: 'CastCo' },
    });
    expect((await post({ body: 'Pack in the grey box', line_id: one.id, readers: 'staff' }).expect(201)).body).toMatchObject({ partner: null });
    await post({ body: 'Courier booked', readers: 'staff' }).expect(201);

    // On the order only staff read it, whatever staff were told.
    const onOrder = await post({ body: 'Luna pays on Friday', readers: tenant.castco.id }).expect(409);
    expectDocumented(readersChangedResponseSchema, onOrder.body);
    expect(onOrder.body).toMatchObject({ code: 'readers_changed', partner: null });

    // MetalWorks accepts line 1 after staff were told only they would read it: nothing is saved, and the 409 names MetalWorks.
    await tenant.metalworks.person.post(`/partner-portal/partners/${tenant.metalworks.id}/jobs/${one.group_id}/accept`).expect(200);
    const accepted = await post({ body: 'Luna is a difficult customer', line_id: one.id, readers: 'staff' }).expect(409);
    expectDocumented(readersChangedResponseSchema, accepted.body);
    expect(accepted.body).toMatchObject({ code: 'readers_changed', partner: { id: tenant.metalworks.id, name: 'MetalWorks' } });
    const saved = list<StaffComment>(await tenant.staff.get(staffPath(tenant)).expect(200)).map((comment) => comment.body);
    expect(saved).toEqual(['Polish the back harder', 'Pack in the grey box', 'Courier booked']);
    expect(list<PartnerComment>(await tenant.metalworks.person.get(jobPath(tenant, tenant.metalworks, 1)).expect(200))).toEqual([]);

    // Neither `staff` nor a partner id is a 400.
    await post({ body: 'Hello', readers: 'customer' }).expect(400);
  });

  it('gives the customer no comments, and keeps its people\'s earlier ones for staff', async () => {
    const tenant = await freshTenant();
    const zero = tenant.order.lines[0];
    // Customers neither read nor write comments.
    await tenant.buyer.get(customerPath(tenant)).expect(404);
    await tenant.buyer.post(customerPath(tenant), { body: 'Can the clasp be gold?' }).expect(404);

    // One Ben wrote on line 0 before then, written straight to the database: staff still read it as his,
    // and CastCo, holding the line, doesn't.
    await prisma.inTenant(tenant.id, (tx) =>
      tx.orderComment.create({ data: { orderId: tenant.order.id, lineId: zero.id, authorUserId: tenant.buyer.id, authorKind: 'customer', body: 'Can the clasp be gold?' } }),
    );
    const staffSees = await tenant.staff.get(staffPath(tenant)).expect(200);
    expectDocumented(pageSchema(orderCommentResponseSchema), staffSees.body);
    expect(list<StaffComment>(staffSees)).toMatchObject([{ line_id: zero.id, author: { kind: 'customer', name: 'Ben' }, partner: null }]);
    expect(list<PartnerComment>(await tenant.castco.person.get(jobPath(tenant, tenant.castco)).expect(200))).toEqual([]);
  });

  it('refuses attachments staff may not use, and links to ones the reader may not see', async () => {
    const tenant = await freshTenant();
    const zero = tenant.order.lines[0];
    const workspaces = await upload(tenant);
    const notUploaded = await upload(tenant, 'pending');

    // Staff attach files of the workspace, but not one that isn't uploaded; nothing was saved by a refusal.
    const staffRefused = await tenant.staff.post(staffPath(tenant), { body: 'See attached', attachments: [workspaces, notUploaded] }).expect(404);
    expect((staffRefused.body as { errors: { path: string }[] }).errors[0].path).toBe('attachments.1');
    expect(list<StaffComment>(await tenant.staff.get(staffPath(tenant)).expect(200))).toEqual([]);

    const onLine = (await tenant.staff.post(staffPath(tenant), { body: 'Match this', line_id: zero.id, attachments: [workspaces] }).expect(201))
      .body as StaffComment;
    const link = (path: string, comment: string, file: string) => `${path}/${comment}/attachments/${file}/url`;

    // CastCo downloads what was written on its line, and not another file by naming it there; MetalWorks
    // nothing; staff both.
    const own = await tenant.castco.person.get(link(jobPath(tenant, tenant.castco), onLine.id, workspaces)).expect(200);
    expect(own.body).toEqual({ url: expect.any(String), expires_at: expect.any(String) });
    await tenant.castco.person.get(link(jobPath(tenant, tenant.castco), onLine.id, notUploaded)).expect(404);
    await tenant.metalworks.person.get(link(jobPath(tenant, tenant.metalworks, 1), onLine.id, workspaces)).expect(404);
    await tenant.staff.get(link(staffPath(tenant), onLine.id, workspaces)).expect(200);
  });

  it('refuses what is malformed', async () => {
    const tenant = await freshTenant();
    const zero = tenant.order.lines[0];
    const other = await tenant.place([1]);
    const comment = { body: 'Hello' };

    // Nobody picks a reader: neither `visibility` nor the older flag is taken.
    for (const visibility of ['partner', 'staff', 'customer']) {
      await tenant.staff.post(staffPath(tenant), { ...comment, line_id: zero.id, visibility }).expect(400);
    }
    await tenant.staff.post(staffPath(tenant), { ...comment, for_partner: true }).expect(400);
    // A line of another order.
    await tenant.staff.post(staffPath(tenant), { ...comment, line_id: other.lines[0].id }).expect(400);
    // A partner writes text only.
    await tenant.castco.person.post(jobPath(tenant, tenant.castco), { ...comment, attachments: [] }).expect(400);

    // Length: 1 to 5000 characters, at most 10 attachments.
    await tenant.staff.post(staffPath(tenant), { body: 'x'.repeat(5001) }).expect(400);
    await tenant.staff.post(staffPath(tenant), { body: '' }).expect(400);
    await tenant.staff.post(staffPath(tenant), { body: 'x'.repeat(5000) }).expect(201);
    const files = Array.from({ length: 11 }, () => '0190a1b2-0000-7000-8000-000000000000');
    await tenant.staff.post(staffPath(tenant), { ...comment, attachments: files }).expect(400);
    await tenant.staff.get('/orders/0190a1b2-0000-7000-8000-000000000000/comments').expect(404);
  });
});
