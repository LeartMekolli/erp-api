import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import type { GroupSummary } from '../src/modules/workflow/group-summary';
import { moveListItemSchema } from '../src/modules/workflow/move-history-response';
import { stepCountsResponseSchema, stepGroupSchema, workOrderListItemSchema } from '../src/modules/workflow/work-order-response';
import { expectDocumented } from './documented';
import { deleteTestTenants } from './factories';
import { orderWorkspace } from './order-fixtures';
import type { Client, OrderWorkspace } from './order-fixtures';

interface Piece {
  id: string;
  may_work: boolean;
  held: 'waiting_for_payment' | 'waiting_for_parts' | null;
  in_rework: boolean;
  group: GroupSummary;
  step: { key: string } | null;
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

  it("moves a group's promise with its order's when the order is paid", async () => {
    const w = await workspace();
    const order = await w.placed({ unpaid: true });
    const group = order.lines[0].group_id;
    // As if placed on an earlier day: the promise it started with is long gone by the time it is paid.
    await prisma.inTenant(w.id, (tx) => tx.workOrderGroup.update({ where: { id: group }, data: { dueOn: new Date(day(-30)) } }));

    await w.pay(order);
    const promised = await promiseOf(w, order.id);
    expect(promised).not.toBe(day(-30));
    expect(await summaryOf(w.staff, group)).toMatchObject({ due_on: promised, late: false });
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

  it('marks the pieces of an order waiting for payment as held, never workable', async () => {
    const w = await workspace();
    const order = await w.placed({ inHouse: true, unpaid: true });
    const group = order.lines[0].group_id;

    const waiting = await piecesOf(w.staff, group);
    expect(waiting).toHaveLength(10);
    for (const piece of waiting) expect(piece).toMatchObject({ held: 'waiting_for_payment', may_work: false });
    expect(await listed(w.staff, `/workflow/work-orders?workable=true&group_id=${group}`)).toHaveLength(0);

    // Paid: workable, and a piece the list offers moves.
    await w.pay(order);
    const paid = await piecesOf(w.staff, group);
    for (const piece of paid) expect(piece).toMatchObject({ held: null, may_work: true });
    expect(await listed(w.staff, `/workflow/work-orders?workable=true&group_id=${group}`)).toHaveLength(10);
    await w.staff.post('/workflow/moves', { work_order_ids: [paid[0].id], at_step: paid[0].step!.key, kind: 'pass' }).expect(200);
  });

  it('holds an assembly at its first step until its parts are ready', async () => {
    const w = await workspace();
    const set = await w.placed({ assembly: true });
    const line = set.lines[0].group_id;
    const parts = await partGroups(w, set.id);
    const atAssembly = async () => (await piecesOf(w.staff, line)).filter((piece) => piece.step?.key === 'assembly');

    const held = await piecesOf(w.staff, line);
    expect(held.length).toBeGreaterThan(1);
    for (const piece of held) expect(piece).toMatchObject({ step: { key: 'assembly' }, held: 'waiting_for_parts', may_work: false });
    for (const part of parts) {
      for (const piece of await piecesOf(w.staff, part.id)) expect(piece).toMatchObject({ held: null, may_work: true });
    }
    // The list and the move agree.
    await w.staff.post('/workflow/moves', { work_order_ids: [held[0].id], at_step: 'assembly', kind: 'pass' }).expect(409);

    // A piece already past its first step (a part reopened after the set moved on) is held too: the move
    // guard refuses any move that doesn't land on the first step while a part isn't ready.
    await putAt(w, [held[0].id], 'packing');
    for (const piece of await piecesOf(w.staff, line)) expect(piece).toMatchObject({ held: 'waiting_for_parts', may_work: false });
    await w.staff.post('/workflow/moves', { work_order_ids: [held[0].id], at_step: 'packing', kind: 'pass' }).expect(409);

    // Every part finished: nothing held, and the list's workable piece moves.
    const finishParts = () =>
      prisma.inTenant(w.id, (tx) =>
        tx.workOrder.updateMany({ where: { groupId: { in: parts.map((part) => part.id) } }, data: { status: 'finished', currentStepId: null } }),
      );
    await finishParts();
    const ready = await atAssembly();
    for (const piece of ready) expect(piece).toMatchObject({ held: null, may_work: true });

    // A finished part reopened: held again.
    const reopened = parts[0].id;
    await prisma.inTenant(w.id, async (tx) => {
      const { workflowVersionId } = await tx.workOrderGroup.findUniqueOrThrow({ where: { id: reopened } });
      const first = await tx.workflowStep.findFirstOrThrow({ where: { versionId: workflowVersionId }, orderBy: { position: 'asc' } });
      await tx.workOrder.updateMany({ where: { groupId: reopened }, data: { status: 'active', currentStepId: first.id } });
    });
    for (const piece of await atAssembly()) expect(piece).toMatchObject({ held: 'waiting_for_parts', may_work: false });

    // A part with nothing live (every piece scrapped) isn't ready either.
    await prisma.inTenant(w.id, (tx) => tx.workOrder.updateMany({ where: { groupId: reopened }, data: { status: 'scrapped', currentStepId: null } }));
    for (const piece of await atAssembly()) expect(piece.held).toBe('waiting_for_parts');

    // Ready again: a pass at the first step goes through.
    await finishParts();
    const [first] = await atAssembly();
    expect(first).toMatchObject({ held: null, may_work: true });
    await w.staff.post('/workflow/moves', { work_order_ids: [first.id], at_step: 'assembly', kind: 'pass' }).expect(200);
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

  /** A new version of the cast workflow with a workspace step `stone_setting` before final QC that needs a skill. */
  const withSettingStep = async (w: OrderWorkspace) => {
    const skillId = (((await w.staff.post('/skills', { name: 'Setting' }).expect(201)).body as { id: string })).id;
    const stepTypeId = (
      (await w.staff.post('/pricing/step-types', { key: 'stone_setting', name: 'Stone setting', position: 45, summary_group: null }).expect(201))
        .body as { id: string }
    ).id;
    await w.set.cast.workflow.setSteps([
      { key: 'stone_setting', name: 'Stone setting', step_type_id: stepTypeId, done_by: 'workspace', required_skill_id: skillId },
    ]);
  };
  interface StepCount {
    key: string;
    name: string;
    active: number;
    in_rework: number;
    workable: number;
    held: number;
  }
  const countsOf = async (client: Client, query: string) => {
    const counted = await client.get(`/workflow/work-orders/counts?${query}`).expect(200);
    expectDocumented(stepCountsResponseSchema, counted.body);
    return (counted.body as { steps: StepCount[] }).steps;
  };

  it('counts the active pieces at every step of the workflow, matching the list', async () => {
    const w = await workspace();
    const cast = w.set.cast.workflow;
    await withSettingStep(w);
    const reworked = await w.placed({ inHouse: true });
    const setting = await w.placed({ inHouse: true });
    await w.staff.post('/workflow/groups', { quote_id: await w.quoted() }).expect(201);
    await moveAllTo(w, reworked.lines[0].group_id, 'casting');
    await moveAllTo(w, setting.lines[0].group_id, 'stone_setting');
    const atCasting = await piecesOf(w.staff, reworked.lines[0].group_id);
    await w.staff
      .post('/workflow/moves', { work_order_ids: atCasting.slice(0, 3).map((piece) => piece.id), at_step: 'casting', kind: 'fail', defect_id: cast.defects.porosity })
      .expect(200);

    const keys = [...cast.stepKeys.slice(0, 5), 'stone_setting', 'final_qc', 'packing'];
    const member = await w.holding(['workflow.read', 'workflow.move', 'order.read']);
    for (const [client, q] of [
      [w.staff, ''],
      [member, ''],
      [w.staff, `&q=${reworked.number}`],
    ] as const) {
      const steps = await countsOf(client, `workflow_id=${cast.workflowId}${q}`);
      expect(steps.map((step) => step.key)).toEqual(keys);
      for (const step of steps) {
        const pieces = await listed(client, `/workflow/work-orders?workflow_id=${cast.workflowId}&step_key=${step.key}&status=active${q}`);
        expect({ key: step.key, active: step.active }).toEqual({ key: step.key, active: pieces.length });
        expect(step.in_rework).toBe(pieces.filter((piece) => piece.in_rework).length);
        expect(step.workable).toBe(pieces.filter((piece) => piece.may_work).length);
        expect(step.held).toBe(pieces.filter((piece) => piece.held !== null).length);
      }
    }

    const byKey = (steps: StepCount[]) => Object.fromEntries(steps.map((step) => [step.key, step]));
    const all = byKey(await countsOf(w.staff, `workflow_id=${cast.workflowId}`));
    expect(all.print_pattern).toEqual({ key: 'print_pattern', name: 'Print pattern', active: 10, in_rework: 0, workable: 10, held: 0 });
    expect(all.casting).toMatchObject({ active: 10, in_rework: 3, workable: 10 });
    expect(all.stone_setting).toMatchObject({ name: 'Stone setting', active: 10, workable: 10 });
    expect(all.packing).toMatchObject({ active: 0, in_rework: 0, workable: 0 });
    // Without the skill, the step's pieces are counted but not workable.
    expect(byKey(await countsOf(member, `workflow_id=${cast.workflowId}`)).stone_setting).toMatchObject({ active: 10, workable: 0 });
    // Searched: only the reworked order's pieces.
    const searched = byKey(await countsOf(w.staff, `workflow_id=${cast.workflowId}&q=${reworked.number}`));
    expect(searched.casting).toMatchObject({ active: 10, in_rework: 3 });
    expect(searched.stone_setting.active).toBe(0);
    expect(searched.print_pattern.active).toBe(0);
  });

  it('keeps a step only an older version has, after the current steps', async () => {
    const w = await workspace();
    const cast = w.set.cast.workflow;
    await withSettingStep(w);
    const order = await w.placed({ inHouse: true });
    await moveAllTo(w, order.lines[0].group_id, 'stone_setting');
    // The next version drops the step; the pieces already there stay on theirs.
    await cast.setSteps();

    const steps = await countsOf(w.staff, `workflow_id=${cast.workflowId}`);
    expect(steps.map((step) => step.key)).toEqual([...cast.stepKeys, 'stone_setting']);
    expect(steps.at(-1)).toEqual({ key: 'stone_setting', name: 'Stone setting', active: 10, in_rework: 0, workable: 10, held: 0 });
  });

  it('needs workflow_id', async () => {
    const w = await workspace();
    await w.staff.get('/workflow/work-orders/counts').expect(400);
    await w.staff.get('/workflow/work-orders/counts?workflow_id=not-a-uuid').expect(400);
    await w.staff.get(`/workflow/work-orders/counts?workflow_id=${randomUUID()}`).expect(404);
  });

  interface StepGroup {
    group: GroupSummary;
    count: number;
    in_rework: number;
    workable: number;
    to_inspect: number;
    held: number;
    held_reason: 'waiting_for_payment' | 'waiting_for_parts' | null;
  }
  /** Every row of the order lines at `step`, through every page. */
  const linesAt = async (client: Client, workflowId: string, step: string, extra = '', limit = 50) => {
    const rows: StepGroup[] = [];
    const pages: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await client
        .get(`/workflow/work-orders/groups?workflow_id=${workflowId}&step_key=${step}&limit=${limit}${extra}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        .expect(200);
      expectDocumented(pageSchema(stepGroupSchema), page.body);
      const body = page.body as { data: StepGroup[]; next_cursor: string | null };
      rows.push(...body.data);
      pages.push(body.data.length);
      cursor = body.next_cursor;
    } while (cursor);
    return { rows, pages };
  };
  /** Puts `pieces` at their workflow's step `key`. */
  const putAt = (w: OrderWorkspace, pieces: string[], key: string) =>
    prisma.inTenant(w.id, async (tx) => {
      const [first] = await tx.workOrder.findMany({ where: { id: { in: pieces } }, select: { group: { select: { workflowVersionId: true } } } });
      const step = await tx.workflowStep.findFirstOrThrow({ where: { versionId: first.group.workflowVersionId, key } });
      await tx.workOrder.updateMany({ where: { id: { in: pieces } }, data: { currentStepId: step.id } });
    });

  it('lists one row per order line at a step, with its counts', async () => {
    const w = await workspace();
    const cast = w.set.cast.workflow;
    const inspectionType = (
      (await w.staff.post('/pricing/step-types', { key: 'inspection', name: 'Inspection', position: 85, summary_group: null }).expect(201)).body as {
        id: string;
      }
    ).id;
    await cast.setSteps([{ key: 'inspection', name: 'Inspection', step_type_id: inspectionType, done_by: 'workspace', sampling: { inspect: 2, of_every: 10 } }]);

    // 6 of a line's 10 pieces at polishing, 4 past it; one of the 6 failed and sent back.
    const polished = await w.placed({ inHouse: true });
    const pieces = (await piecesOf(w.staff, polished.lines[0].group_id)).map((piece) => piece.id);
    await putAt(w, pieces.slice(0, 6), 'polishing');
    await putAt(w, pieces.slice(6), 'plating');
    await w.staff
      .post('/workflow/moves', {
        work_order_ids: [pieces[0]],
        at_step: 'polishing',
        kind: 'fail',
        defect_id: cast.defects.scratch,
        comment: 'Seen under the lamp',
        answers: [{ item: 'surface', value: 'pitted' }],
      })
      .expect(200);

    const { rows } = await linesAt(w.staff, cast.workflowId, 'polishing');
    expect(rows).toEqual([
      { group: expect.objectContaining({ id: polished.lines[0].group_id, source: 'order_line' }), count: 6, in_rework: 1, workable: 6, to_inspect: 0, held: 0, held_reason: null },
    ]);
    // Without workflow.move, nothing is workable.
    expect((await linesAt(await w.holding(['workflow.read']), cast.workflowId, 'polishing')).rows[0]).toMatchObject({ count: 6, workable: 0 });

    // At a step that samples: as many to inspect as the work list marks.
    const sampled = await w.placed({ inHouse: true });
    const all = (await piecesOf(w.staff, sampled.lines[0].group_id)).map((piece) => piece.id);
    // Passed at polishing, the last step before inspection on their path (plating isn't priced for them).
    await putAt(w, all, 'polishing');
    await w.staff
      .post('/workflow/moves', { work_order_ids: all, at_step: 'polishing', kind: 'pass', answers: [{ item: 'surface', value: 'ok' }] })
      .expect(200);
    const marked = (await listed(w.staff, `/workflow/work-orders?group_id=${sampled.lines[0].group_id}&step_key=inspection`)).filter(
      (piece) => (piece as Piece & { to_inspect: boolean | null }).to_inspect === true,
    ).length;
    const [atInspection] = (await linesAt(w.staff, cast.workflowId, 'inspection')).rows;
    expect(atInspection).toMatchObject({ group: { id: sampled.lines[0].group_id }, count: 10, to_inspect: marked });
    expect(marked).toBeGreaterThan(0);
    expect(marked).toBeLessThan(10);
  });

  it('counts held pieces at each step and in each line, never as workable', async () => {
    const w = await workspace();
    const cast = w.set.cast.workflow.workflowId;
    const unpaid = (await w.placed({ inHouse: true, unpaid: true })).lines[0].group_id;
    // The set in a workspace of its own: its parts' pieces would otherwise count at the cast steps too.
    const v = await workspace();
    const set = (await v.placed({ assembly: true })).lines[0].group_id;
    const setPieces = (await piecesOf(v.staff, set)).length;
    const setWorkflow = (await summaryOf(v.staff, set)).workflow.id;
    const at = async (client: Client, workflowId: string, key: string, extra = '') =>
      (await countsOf(client, `workflow_id=${workflowId}${extra}`)).find((step) => step.key === key)!;

    expect(await at(w.staff, cast, 'print_pattern')).toMatchObject({ active: 10, held: 10, workable: 0 });
    expect(await at(v.staff, setWorkflow, 'assembly')).toMatchObject({ active: setPieces, held: setPieces, workable: 0 });

    expect((await linesAt(w.staff, cast, 'print_pattern')).rows).toEqual([
      expect.objectContaining({ group: expect.objectContaining({ id: unpaid }), count: 10, held: 10, held_reason: 'waiting_for_payment', workable: 0 }),
    ]);
    expect((await linesAt(v.staff, setWorkflow, 'assembly')).rows).toEqual([
      expect.objectContaining({ group: expect.objectContaining({ id: set }), count: setPieces, held: setPieces, held_reason: 'waiting_for_parts', workable: 0 }),
    ]);

    // Only what I can work: nothing held.
    expect(await at(w.staff, cast, 'print_pattern', '&workable=true')).toMatchObject({ active: 0, held: 0 });
    expect((await linesAt(w.staff, cast, 'print_pattern', '&workable=true')).rows).toEqual([]);

    // Without workflow.move: nothing is workable, and the holds still show.
    const reader = await w.holding(['workflow.read']);
    expect(await at(reader, cast, 'print_pattern')).toMatchObject({ active: 10, held: 10, workable: 0 });
    expect((await linesAt(reader, cast, 'print_pattern')).rows[0]).toMatchObject({ held: 10, held_reason: 'waiting_for_payment' });
  });

  it('pages by line, never splitting one, in the chosen sort', async () => {
    const w = await workspace();
    const cast = w.set.cast.workflow;
    const lines: string[] = [];
    for (let made = 0; made < 3; made += 1) lines.push((await w.placed({ inHouse: true })).lines[0].group_id);
    const [late, early, middle] = lines;
    const due = { [late]: day(12), [early]: day(4), [middle]: day(8) };
    await prisma.inTenant(w.id, async (tx) => {
      for (const group of lines) await tx.workOrderGroup.update({ where: { id: group }, data: { dueOn: new Date(due[group]) } });
    });
    for (const group of lines) await moveAllTo(w, group, 'casting');
    // 3 of the middle line's pieces already past casting.
    await putAt(w, (await piecesOf(w.staff, middle)).slice(0, 3).map((piece) => piece.id), 'polishing');

    const { rows, pages } = await linesAt(w.staff, cast.workflowId, 'casting', '&sort=due_on', 1);
    expect(pages).toEqual([1, 1, 1]);
    expect(rows.map((row) => [row.group.id, row.group.due_on, row.count])).toEqual([
      [early, due[early], 10],
      [middle, due[middle], 7],
      [late, due[late], 10],
    ]);
    const latest = await linesAt(w.staff, cast.workflowId, 'casting', '&sort=-due_on', 1);
    expect(latest.rows.map((row) => row.group.id)).toEqual([late, middle, early]);
  });

  it('pages lines in every sort, undated and rank ties included', async () => {
    const w = await workspace();
    const cast = w.set.cast.workflow;
    const lines: string[] = [];
    for (let made = 0; made < 3; made += 1) lines.push((await w.placed({ inHouse: true })).lines[0].group_id);
    const quotes: string[] = [];
    for (let made = 0; made < 2; made += 1) {
      quotes.push(((await w.staff.post('/workflow/groups', { quote_id: await w.quoted() }).expect(201)).body as { id: string }).id);
    }
    // Two lines due the same day at different ranks, one later; two undated quotes, one ranked higher.
    const dueOf: Record<string, string | null> = { [lines[0]]: day(6), [lines[1]]: day(6), [lines[2]]: day(9), [quotes[0]]: null, [quotes[1]]: null };
    const rankOf: Record<string, number> = { [lines[0]]: 0, [lines[1]]: 3, [lines[2]]: 0, [quotes[0]]: 0, [quotes[1]]: 3 };
    await prisma.inTenant(w.id, async (tx) => {
      for (const group of [...lines, ...quotes]) {
        await tx.workOrderGroup.update({ where: { id: group }, data: { dueOn: dueOf[group] ? new Date(dueOf[group]) : null, queueRank: rankOf[group] } });
      }
    });
    for (const group of [...lines, ...quotes]) await moveAllTo(w, group, 'casting');

    const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const byRank = (a: string, b: string) => rankOf[b] - rankOf[a] || byId(a, b);
    const byDue = (direction: 1 | -1) => (a: string, b: string) => {
      const [first, second] = [dueOf[a], dueOf[b]];
      if (first === second) return byRank(a, b);
      if (first === null) return 1;
      if (second === null) return -1;
      return (first < second ? -1 : 1) * direction;
    };
    const rules: Record<string, (a: string, b: string) => number> = { due_on: byDue(1), '-due_on': byDue(-1), priority: byRank, started: byId };
    for (const [sort, rule] of Object.entries(rules)) {
      const { rows, pages } = await linesAt(w.staff, cast.workflowId, 'casting', `&sort=${sort}`, 2);
      expect(pages).toEqual([2, 2, 1]);
      expect(rows.map((row) => row.group.id)).toEqual([...lines, ...quotes].sort(rule));
    }
  });

  interface MoveRow {
    id: string;
    kind: string;
    from_step: { key: string } | null;
    groups: { group: GroupSummary; count: number; partner: { id: string; name: string } | null }[];
  }
  /** Every move `query` picks, through every page, and the size of each page. */
  const movesOf = async (client: Client, query: string, limit = 50) => {
    const rows: MoveRow[] = [];
    const pages: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await client.get(`/workflow/moves?limit=${limit}${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
      expectDocumented(pageSchema(moveListItemSchema), page.body);
      const body = page.body as { data: MoveRow[]; next_cursor: string | null };
      rows.push(...body.data);
      pages.push(body.data.length);
      cursor = body.next_cursor;
    } while (cursor);
    return { rows, pages };
  };
  const passAt = (w: OrderWorkspace, pieces: string[], step: string) =>
    w.staff.post('/workflow/moves', { work_order_ids: pieces, at_step: step, kind: 'pass' }).expect(200);

  it('lists the history one row per move, newest first', async () => {
    const w = await workspace();
    const cast = w.set.cast.workflow;
    const order = await w.placed({ inHouse: true });
    const group = order.lines[0].group_id;
    const pieces = (await piecesOf(w.staff, group)).map((piece) => piece.id);
    await passAt(w, pieces, 'print_pattern');
    await passAt(w, pieces, 'casting_tree');
    await w.staff
      .post('/workflow/moves', { work_order_ids: pieces.slice(0, 2), at_step: 'casting', kind: 'fail', defect_id: cast.defects.porosity })
      .expect(200);

    const { rows } = await movesOf(w.staff, '');
    expect(rows.map((row) => [row.kind, row.from_step?.key, row.groups.map((entry) => [entry.group.id, entry.count, entry.partner])])).toEqual([
      ['fail', 'casting', [[group, 2, null]]],
      ['pass', 'casting_tree', [[group, 10, null]]],
      ['pass', 'print_pattern', [[group, 10, null]]],
    ]);
    expect(rows[0].groups[0].group).toMatchObject({ source: 'order_line', order: { id: order.id } });

    expect((await movesOf(w.staff, '&kind=fail')).rows.map((row) => row.id)).toEqual([rows[0].id]);
    expect((await movesOf(w.staff, `&workflow_id=${cast.workflowId}`)).rows).toHaveLength(3);
    expect((await movesOf(w.staff, `&workflow_id=${randomUUID()}`)).rows).toEqual([]);
    await w.staff.get('/workflow/moves?kind=scrap').expect(400);
  });

  it('keeps a move whole when only one of its lines matches', async () => {
    // One move can't span two workflow versions (moves.service), so the line left out is left out by `q`.
    const w = await workspace();
    const held = await w.placed();
    const inHouse = await w.placed({ inHouse: true });
    const pieces = [
      ...(await piecesOf(w.staff, held.lines[0].group_id)).map((piece) => piece.id),
      ...(await piecesOf(w.staff, inHouse.lines[0].group_id)).map((piece) => piece.id),
    ];
    await passAt(w, pieces, 'print_pattern');

    const { rows } = await movesOf(w.staff, `&q=${held.number}`);
    expect(rows).toHaveLength(1);
    expect(
      rows[0].groups
        .map((entry) => ({ group: entry.group.id, count: entry.count, partner: entry.partner?.name ?? null }))
        .sort((a, b) => (a.group < b.group ? -1 : 1)),
    ).toEqual(
      [
        { group: held.lines[0].group_id, count: 10, partner: 'CastCo' },
        { group: inHouse.lines[0].group_id, count: 10, partner: null },
      ].sort((a, b) => (a.group < b.group ? -1 : 1)),
    );
    // Without order.read, the number finds no line, so no move.
    expect((await movesOf(await w.holding(['workflow.read']), `&q=${held.number}`)).rows).toEqual([]);
  });

  it('pages by move', async () => {
    const w = await workspace();
    const order = await w.placed({ inHouse: true });
    const pieces = (await piecesOf(w.staff, order.lines[0].group_id)).map((piece) => piece.id);
    for (const step of ['print_pattern', 'casting_tree', 'casting']) await passAt(w, pieces, step);

    const { rows, pages } = await movesOf(w.staff, '', 1);
    expect(pages).toEqual([1, 1, 1]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(rows.map((row) => row.from_step?.key)).toEqual(['casting', 'casting_tree', 'print_pattern']);
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

  it("refuses another list's cursor", async () => {
    const w = await workspace();
    const cast = w.set.cast.workflow;
    for (let made = 0; made < 2; made += 1) {
      const order = await w.placed({ inHouse: true });
      const pieces = (await piecesOf(w.staff, order.lines[0].group_id)).map((piece) => piece.id);
      await w.staff.post('/workflow/moves', { work_order_ids: pieces, at_step: 'print_pattern', kind: 'pass' }).expect(200);
    }
    const next = async (path: string) => {
      const page = await w.staff.get(path).expect(200);
      return encodeURIComponent((page.body as { next_cursor: string }).next_cursor);
    };
    const lines = `/workflow/work-orders/groups?workflow_id=${cast.workflowId}&step_key=casting_tree`;

    for (const sort of ['priority', 'due_on', 'started']) {
      const pieces = await next(`/workflow/work-orders?sort=${sort}&limit=1`);
      const groups = await next(`${lines}&sort=${sort}&limit=1`);
      await w.staff.get(`${lines}&sort=${sort}&cursor=${pieces}`).expect(400);
      await w.staff.get(`/workflow/work-orders?sort=${sort}&cursor=${groups}`).expect(400);
      await w.staff.get(`${lines}&sort=${sort}&cursor=${groups}`).expect(200);
    }

    const moves = await next('/workflow/moves?limit=1');
    const transitions = await next('/workflow/transitions?limit=1');
    await w.staff.get(`/workflow/transitions?cursor=${moves}`).expect(400);
    await w.staff.get(`/workflow/moves?cursor=${transitions}`).expect(400);
    await w.staff.get(`/workflow/moves?cursor=${moves}`).expect(200);
  });
});
