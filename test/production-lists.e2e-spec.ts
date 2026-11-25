import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import type { GroupSummary } from '../src/modules/workflow/group-summary';
import { workOrderListItemSchema } from '../src/modules/workflow/work-order-response';
import { expectDocumented } from './documented';
import { deleteTestTenants } from './factories';
import { orderWorkspace } from './order-fixtures';
import type { Client, OrderWorkspace } from './order-fixtures';

interface Piece {
  id: string;
  group: GroupSummary;
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Production lists (spec 2026-11-24): what Production reads across every order. Whose each piece is and
 * when it is due, the work list's filters and sorts, the counts per step, the order lines at a step, and
 * the QC history one move at a time.
 */
describe('workflow: production lists', () => {
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
  const workspace = () => orderWorkspace(prisma, tokens, as, { runMetal, createdTenants });

  /** The pieces of one group, as `client` reads the work list. */
  const piecesOf = async (client: Client, group: string) => {
    const listed = await client.get(`/workflow/work-orders?group_id=${group}&limit=200`).expect(200);
    expectDocumented(pageSchema(workOrderListItemSchema), listed.body);
    return (listed.body as { data: Piece[] }).data;
  };
  const summaryOf = async (client: Client, group: string) => (await piecesOf(client, group))[0].group;
  const promiseOf = async (w: OrderWorkspace, orderId: string) =>
    (await prisma.inTenant(w.id, (tx) => tx.order.findUniqueOrThrow({ where: { id: orderId } }))).promisedOn.toISOString().slice(0, 10);
  /** The groups of an assembly order's parts. */
  const partGroups = (w: OrderWorkspace, orderId: string) =>
    prisma.inTenant(w.id, (tx) => tx.workOrderGroup.findMany({ where: { orderLinePart: { is: { line: { orderId } } } }, select: { id: true } }));
  /** A remake of 2 pieces of a delivered order's line, decided at the workshop's fault. */
  const remade = async (w: OrderWorkspace) => {
    const order = await w.delivered();
    const claim = await w.claim(order);
    const decided = await w.staff
      .post(`/claims/${claim.id}/lines/${claim.lines[0].id}/decision`, { fault: 'workshop', outcome: 'remake', note: 'Porous casting' })
      .expect(200);
    const group = (decided.body as { remake: { group_id: string } }).remake.group_id;
    const number = (await prisma.inTenant(w.id, (tx) => tx.claim.findUniqueOrThrow({ where: { id: claim.id } }))).number;
    return { order, claim: { id: claim.id, number }, group };
  };

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

  it('tells each piece whose it is and when it is due', async () => {
    const w = await workspace();
    const cast = w.set.cast;

    // An order line held by CastCo.
    const order = await w.placed();
    const lineGroup = order.lines[0].group_id;
    const job = await prisma.inTenant(w.id, (tx) => tx.jobAssignment.findFirstOrThrow({ where: { groupId: lineGroup, status: 'accepted' } }));
    expect(await summaryOf(w.staff, lineGroup)).toEqual({
      id: lineGroup,
      workflow: { id: expect.any(String), name: expect.any(String), version: 1 },
      product: {
        id: cast.productId,
        name: expect.any(String),
        options: expect.arrayContaining([expect.objectContaining({ group: expect.objectContaining({ key: 'material' }) })]),
        size: { scale: '1.5' },
      },
      source: 'order_line',
      order: { id: order.id, number: order.number, line_id: order.lines[0].id },
      claim: null,
      customer: { id: w.luna, name: 'Luna Jewels' },
      due_on: await promiseOf(w, order.id),
      late: false,
      priority: { key: 'standard', name: 'Standard' },
      partner: { id: w.castco.id, name: 'CastCo', due_on: job.dueOn!.toISOString().slice(0, 10), late: false },
    });

    // A part of an assembly: the assembly's line, made in-house.
    const assembly = await w.placed({ assembly: true });
    const [part] = await partGroups(w, assembly.id);
    expect(await summaryOf(w.staff, part.id)).toMatchObject({
      source: 'order_line_part',
      order: { id: assembly.id, number: assembly.number, line_id: assembly.lines[0].id },
      claim: null,
      due_on: await promiseOf(w, assembly.id),
      partner: null,
    });

    // A remake: the claimed order and line, the claim, and its own promise.
    const remake = await remade(w);
    const stored = await prisma.inTenant(w.id, (tx) => tx.workOrderGroup.findUniqueOrThrow({ where: { id: remake.group } }));
    expect(await summaryOf(w.staff, remake.group)).toMatchObject({
      source: 'claim_line',
      order: { id: remake.order.id, number: remake.order.number, line_id: remake.order.lines[0].id },
      claim: remake.claim,
      product: { id: cast.productId, size: { scale: '1.5' } },
      due_on: stored.dueOn!.toISOString().slice(0, 10),
    });

    // A quote's pieces: nobody's order, due on no day, with nobody.
    const started = await w.staff.post('/workflow/groups', { quote_id: await w.quoted() }).expect(201);
    const quoteGroup = (started.body as { id: string }).id;
    expect(await summaryOf(w.staff, quoteGroup)).toMatchObject({
      source: 'quote',
      product: { id: cast.productId, options: [], size: null },
      order: null,
      claim: null,
      customer: { id: w.luna, name: 'Luna Jewels' },
      due_on: null,
      late: false,
      partner: null,
    });
  });

  it('marks a group late from the promise, and late at the partner from its own date', async () => {
    const w = await workspace();
    const order = await w.placed();
    const group = order.lines[0].group_id;
    const due = (dueOn: string, partnerDueOn: string) =>
      prisma.inTenant(w.id, async (tx) => {
        await tx.workOrderGroup.update({ where: { id: group }, data: { dueOn: new Date(dueOn) } });
        await tx.jobAssignment.updateMany({ where: { groupId: group, status: 'accepted' }, data: { dueOn: new Date(partnerDueOn) } });
      });

    // Past the customer's promise.
    await due(day(-1), day(-3));
    expect(await summaryOf(w.staff, group)).toMatchObject({ late: true, partner: { late: true } });

    // On time for the customer, late at the partner.
    await due(day(1), day(-1));
    expect(await summaryOf(w.staff, group)).toMatchObject({ due_on: day(1), late: false, partner: { due_on: day(-1), late: true } });

    // Nothing left to make: late at neither.
    await due(day(-1), day(-1));
    await prisma.inTenant(w.id, (tx) => tx.workOrder.updateMany({ where: { groupId: group }, data: { status: 'finished', currentStepId: null } }));
    expect(await summaryOf(w.staff, group)).toMatchObject({ late: false, partner: { late: false } });
  });

  it('leaves the order, claim and customer out without order.read or customer.read', async () => {
    const w = await workspace();
    const order = await w.placed();
    const group = order.lines[0].group_id;

    const bare = await summaryOf(await w.holding(['workflow.read']), group);
    expect(bare).not.toHaveProperty('order');
    expect(bare).not.toHaveProperty('claim');
    expect(bare).not.toHaveProperty('customer');
    expect(bare).toMatchObject({ source: 'order_line', due_on: await promiseOf(w, order.id), partner: { name: 'CastCo' } });

    const orders = await summaryOf(await w.holding(['workflow.read', 'order.read']), group);
    expect(orders).toMatchObject({ order: { id: order.id }, claim: null });
    expect(orders).not.toHaveProperty('customer');

    const customers = await summaryOf(await w.holding(['workflow.read', 'customer.read']), group);
    expect(customers).toMatchObject({ customer: { name: 'Luna Jewels' } });
    expect(customers).not.toHaveProperty('order');
  });
});
