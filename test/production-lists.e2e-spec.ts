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

  /** The group ids of every piece `path` lists, through every page. */
  const listed = async (client: Client, path: string, limit = 200) => {
    const pieces: Piece[] = [];
    let cursor: string | null = null;
    do {
      const page = await client.get(`${path}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
      expectDocumented(pageSchema(workOrderListItemSchema), page.body);
      const body = page.body as { data: Piece[]; next_cursor: string | null };
      pieces.push(...body.data);
      cursor = body.next_cursor;
    } while (cursor);
    return pieces;
  };
  const groupsOf = (pieces: Piece[]) => new Set(pieces.map((piece) => piece.group.id));
  /** Puts every piece of `group` at its workflow's step `key`. */
  const moveAllTo = (w: OrderWorkspace, group: string, key: string) =>
    prisma.inTenant(w.id, async (tx) => {
      const { workflowVersionId } = await tx.workOrderGroup.findUniqueOrThrow({ where: { id: group } });
      const step = await tx.workflowStep.findFirstOrThrow({ where: { versionId: workflowVersionId, key } });
      await tx.workOrder.updateMany({ where: { groupId: group }, data: { currentStepId: step.id } });
    });

  it('narrows to one workflow when step keys are shared', async () => {
    const w = await workspace();
    // A cast line, and an assembly whose bail part runs on the printed parts workflow; both have `packing`.
    const order = await w.placed();
    const cast = order.lines[0].group_id;
    const assembly = await w.placed({ assembly: true });
    const parts = await partGroups(w, assembly.id);
    const summaries = await Promise.all(parts.map((part) => summaryOf(w.staff, part.id)));
    const castWorkflow = (await summaryOf(w.staff, cast)).workflow.id;
    const printed = summaries.find((summary) => summary.workflow.id !== castWorkflow)!;
    await moveAllTo(w, cast, 'packing');
    await moveAllTo(w, printed.id, 'packing');

    expect(groupsOf(await listed(w.staff, '/workflow/work-orders?step_key=packing'))).toEqual(new Set([cast, printed.id]));
    expect(groupsOf(await listed(w.staff, `/workflow/work-orders?step_key=packing&workflow_id=${castWorkflow}`))).toEqual(new Set([cast]));
    expect(groupsOf(await listed(w.staff, `/workflow/work-orders?step_key=packing&workflow_id=${printed.workflow.id}`))).toEqual(
      new Set([printed.id]),
    );
  });

  it('finds pieces by order number, claim number, product and customer', async () => {
    const w = await workspace();
    const order = await w.placed();
    const line = order.lines[0].group_id;
    const remake = await remade(w);
    const assembly = await w.placed({ assembly: true });
    const found = async (client: Client, q: string) => groupsOf(await listed(client, `/workflow/work-orders?q=${encodeURIComponent(q)}`));

    // By order number, with or without `#`: the line's group, and nothing of another order.
    for (const q of [`#${order.number}`, `${order.number}`]) {
      const groups = await found(w.staff, q);
      expect(groups).toContain(line);
      expect(groups).not.toContain(assembly.lines[0].group_id);
    }
    // By claim number: the remake.
    expect(await found(w.staff, `${remake.claim.number}`)).toContain(remake.group);
    // By product name, any case: the cast lines and the remake, not the pendant set.
    const byProduct = await found(w.staff, 'CUSTOM CAST');
    expect(byProduct).toContain(line);
    expect(byProduct).toContain(remake.group);
    expect(byProduct).not.toContain(assembly.lines[0].group_id);
    // By customer name: every group of Luna's.
    expect(await found(w.staff, 'luna')).toEqual(await found(w.staff, 'Jewels'));
    expect(await found(w.staff, 'luna')).toContain(assembly.lines[0].group_id);
    // Wildcards are literal.
    expect(await found(w.staff, '%')).toEqual(new Set());
    expect(await found(w.staff, 'Custom_cast')).toEqual(new Set());

    // Without order.read or customer.read, neither the number nor the name finds anything; the product still does.
    const bare = await w.holding(['workflow.read']);
    expect(await found(bare, `${order.number}`)).toEqual(new Set());
    expect(await found(bare, `${remake.claim.number}`)).toEqual(new Set());
    expect(await found(bare, 'luna')).toEqual(new Set());
    expect(await found(bare, 'custom cast')).toContain(line);
  });

  it('sorts due soonest, due latest, by priority and by start, and pages each without repeats', async () => {
    const w = await workspace();
    // Five groups of 10: two due the same day (one ranked higher), one due earlier, one later, and a quote's, undated.
    const groups: string[] = [];
    for (let made = 0; made < 4; made += 1) groups.push((await w.placed()).lines[0].group_id);
    const [early, sameLow, sameHigh, late] = groups;
    const quote = ((await w.staff.post('/workflow/groups', { quote_id: await w.quoted() }).expect(201)).body as { id: string }).id;
    const dueOf: Record<string, string | null> = { [early]: day(5), [sameLow]: day(8), [sameHigh]: day(8), [late]: day(12), [quote]: null };
    const rankOf: Record<string, number> = { [early]: 0, [sameLow]: 0, [sameHigh]: 2, [late]: 0, [quote]: 0 };
    await prisma.inTenant(w.id, async (tx) => {
      for (const group of [early, sameLow, sameHigh, late]) {
        await tx.workOrderGroup.update({ where: { id: group }, data: { dueOn: new Date(dueOf[group]!), queueRank: rankOf[group] } });
      }
    });

    const byId = (a: Piece, b: Piece) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const byRank = (a: Piece, b: Piece) => rankOf[b.group.id] - rankOf[a.group.id] || byId(a, b);
    const byDue = (direction: 1 | -1) => (a: Piece, b: Piece) => {
      const [first, second] = [dueOf[a.group.id], dueOf[b.group.id]];
      if (first !== second) {
        if (first === null) return 1;
        if (second === null) return -1;
        return (first < second ? -1 : 1) * direction;
      }
      return byRank(a, b);
    };
    const rules: Record<string, (a: Piece, b: Piece) => number> = { due_on: byDue(1), '-due_on': byDue(-1), priority: byRank, started: byId };

    for (const [sort, rule] of Object.entries(rules)) {
      const pieces = await listed(w.staff, `/workflow/work-orders?sort=${sort}`, 3);
      expect(new Set(pieces.map((piece) => piece.id)).size).toBe(50);
      expect(pieces).toHaveLength(50);
      expect(pieces.map((piece) => piece.id)).toEqual([...pieces].sort(rule).map((piece) => piece.id));
    }
    // The undated quote's pieces come last in both directions.
    for (const sort of ['due_on', '-due_on']) {
      const pieces = await listed(w.staff, `/workflow/work-orders?sort=${sort}`, 3);
      expect(pieces.slice(-10).every((piece) => piece.group.id === quote)).toBe(true);
    }
  });

  it('refuses a cursor made for another sort', async () => {
    const w = await workspace();
    await w.placed();
    const page = await w.staff.get('/workflow/work-orders?sort=due_on&limit=1').expect(200);
    const cursor = encodeURIComponent((page.body as { next_cursor: string }).next_cursor);

    for (const other of ['priority', '-due_on', 'started']) {
      const refused = await w.staff.get(`/workflow/work-orders?sort=${other}&cursor=${cursor}`).expect(400);
      expect((refused.body as { detail: string }).detail).toMatch(/cursor/i);
    }
    // Left out, the sort is `priority`.
    await w.staff.get(`/workflow/work-orders?cursor=${cursor}`).expect(400);
    await w.staff.get(`/workflow/work-orders?sort=due_on&cursor=${cursor}`).expect(200);
  });
});
