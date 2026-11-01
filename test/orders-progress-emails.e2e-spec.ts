import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { JobsService } from '../src/jobs/jobs.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { resolveAudience } from '../src/modules/notifications/audience';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { ProgressEmailsSweepHandler } from '../src/modules/orders/progress-emails.handler';
import { ProgressEmailsService } from '../src/modules/orders/progress-emails.service';
import { SettingsService } from '../src/modules/settings/settings.service';
import { workflowVersionResponseSchema } from '../src/modules/workflow/workflow-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Piece {
  id: string;
  group_id: string;
  step: { key: string } | null;
}
interface Order {
  id: string;
  number: number;
  lines: { group_id: string }[];
}

/**
 * Workflow 2, Task 4. Rings run on the category's workflow, whose "Casting" step emails the customer;
 * pendants on their own workflow, whose "Wax casting" step shows customers "Casting" too and also emails.
 * Both show polishing as "Finishing", which doesn't email. Luna Jewels has a buyer and is on the default
 * plan, which has `progress_emails`. Polished silver runs print pattern → casting tree → casting →
 * polishing → packing.
 *
 * Moves queue `orders.progress`; here `enqueue` is stubbed, so no worker of another suite sends anything
 * behind a test's back, and the tests call `sendDue` as the job would.
 */
describe('orders: progress emails', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let settings: SettingsService;
  let progress: ProgressEmailsService;
  let notifications: NotificationsService;
  let sweep: ProgressEmailsSweepHandler;
  let enqueue: jest.SpyInstance;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const id = (response: request.Response) => (response.body as { id: string }).id;
  const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const token = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
    const staff = {
      post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    };
    const cast = await pricedCastPart(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });
    const { steps } = cast;
    const { defects } = cast.workflow;

    // Pendants: the same options as the cast part, on a workflow of their own.
    const ringsProduct = (await staff.get(`/catalog/products/${cast.productId}`).expect(200)).body as { options: object[] };
    const pendantId = id(
      await staff
        .post('/catalog/products', {
          category_id: cast.categoryId,
          key: 'custom_pendant',
          name: 'Custom pendant',
          kind: 'custom',
          sizing: { mode: 'range', min: '0.5', max: '2' },
        })
        .expect(201),
    );
    await staff.put(`/catalog/products/${pendantId}/options`, { groups: ringsProduct.options }).expect(200);
    for (const product of [cast.productId, pendantId]) {
      await staff.patch(`/catalog/products/${product}`, { published: true }).expect(200);
    }

    const casting = (key: string, name: string) => ({
      key,
      name,
      step_type_id: steps.casting,
      defects: [{ defect_id: defects.porosity, outcome: 'rework', rework_to: key }],
      rework_targets: [key],
      customer: { visible: true, name: 'Casting', email: true },
    });
    const workflowSteps = (castingStep: object) => [
      { key: 'print_pattern', name: 'Print pattern', step_type_id: steps.printPattern },
      { key: 'casting_tree', name: 'Casting tree', step_type_id: steps.castingTree },
      castingStep,
      {
        key: 'polishing',
        name: 'Polishing',
        step_type_id: steps.polishing,
        defects: [{ defect_id: defects.porosity, outcome: 'rework', rework_to: (castingStep as { key: string }).key }],
        rework_targets: [(castingStep as { key: string }).key],
        customer: { visible: true, name: 'Finishing' },
      },
      { key: 'plating', name: 'Plating', step_type_id: steps.plating },
      { key: 'packing', name: 'Packing', step_type_id: cast.workflow.notPriced.packing },
    ];
    const rings = await staff
      .put(`/workflow/workflows/${cast.workflow.workflowId}/steps`, { steps: workflowSteps(casting('casting', 'Casting')) })
      .expect(200);
    expectDocumented(workflowVersionResponseSchema, rings.body);
    expect((rings.body as { steps: { key: string; customer: object }[] }).steps.find((step) => step.key === 'casting')).toMatchObject({
      customer: { visible: true, name: 'Casting', email: true },
    });
    const pendantWorkflow = id(await staff.post('/workflow/workflows', { key: 'cast_pendants', name: 'Cast pendants' }).expect(201));
    await staff
      .put(`/workflow/workflows/${pendantWorkflow}/steps`, { steps: workflowSteps(casting('wax_casting', 'Wax casting')) })
      .expect(200);
    await staff.put(`/workflow/products/${pendantId}/workflow`, { workflow_id: pendantWorkflow }).expect(200);

    await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
    const luna = id(await staff.post('/customers', { name: 'Luna Jewels' }).expect(201));
    // Pay later, so an order starts at once instead of waiting for payment.
    await staff.put(`/customers/${luna}/payment-terms`, { terms: 'pay_later' }).expect(200);
    const buyer = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.user.update({ where: { id: buyer.id }, data: { kind: 'customer' } });
      await tx.organisationMembership.create({ data: { userId: buyer.id, organisationType: 'customer', organisationId: luna, role: 'buyer' } });
    });
    await setProgressEmails(tenant.id, true);

    const quote = async (productId: string, quantity: number, customerId: string | undefined = luna) =>
      ((
        await staff
          .post('/pricing/quotes', {
            product_id: productId,
            options: { material: 'silver_925', finish: 'polished' },
            size: { scale: '1.5' },
            quantity,
            file_version_id: cast.versionId,
            customer_id: customerId,
          })
          .expect(201)
      ).body as { quote: { id: string } }).quote.id;

    /** Two rings and one pendant, one line each. */
    const placeOrder = async (): Promise<Order> =>
      (
        await staff
          .post('/orders', {
            customer_id: luna,
            lines: [{ quote_id: await quote(cast.productId, 2) }, { quote_id: await quote(pendantId, 1) }],
            address,
            shipping_method: 'courier',
          })
          .expect(201)
      ).body as Order;

    return { id: tenant.id, staff, cast, pendantId, pendantWorkflow, workflowSteps, casting, buyerEmail: buyer.email, quote, placeOrder };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const setProgressEmails = (tenantId: string, on: boolean) =>
    prisma.inTenant(tenantId, (tx) => tx.plan.updateMany({ where: { isDefault: true }, data: { features: on ? ['progress_emails'] : [] } }));

  const placeOrder = (tenant: Tenant) => tenant.placeOrder();
  const piecesOf = async (tenant: Tenant, groupId: string) =>
    ((await tenant.staff.get(`/workflow/work-orders?group_id=${groupId}&limit=100`).expect(200)).body as { data: Piece[] }).data;
  const move = (tenant: Tenant, body: object) => tenant.staff.post('/workflow/moves', body).expect(200);
  const pass = async (tenant: Tenant, groupId: string, ...stepKeys: string[]) => {
    for (const step of stepKeys) {
      await move(tenant, { work_order_ids: (await piecesOf(tenant, groupId)).map((piece) => piece.id), at_step: step, kind: 'pass' });
    }
  };
  const toCastRings = (tenant: Tenant, order: Order) => pass(tenant, order.lines[0]!.group_id, 'print_pattern', 'casting_tree', 'casting');
  const toCastPendant = (tenant: Tenant, order: Order) =>
    pass(tenant, order.lines[1]!.group_id, 'print_pattern', 'casting_tree', 'wax_casting');
  const sendDue = (tenant: Tenant, order: Order) => progress.sendDue(tenant.id, order.lines.map((line) => line.group_id));

  /** The progress emails raised about an order, oldest first. */
  const raised = (tenant: Tenant, orderId: string) =>
    prisma.inTenant(tenant.id, async (tx) =>
      (await tx.notification.findMany({ where: { eventKey: 'order.progress', subjectType: 'order', subjectId: orderId }, orderBy: { id: 'asc' } })).map(
        (row) => row.payload,
      ),
    );
  const recorded = (tenant: Tenant, orderId: string) =>
    prisma.inTenant(tenant.id, async (tx) => (await tx.orderProgressEmail.findMany({ where: { orderId } })).map((row) => row.stepName));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    settings = moduleRef.get(SettingsService);
    progress = moduleRef.get(ProgressEmailsService);
    notifications = moduleRef.get(NotificationsService);
    sweep = moduleRef.get(ProgressEmailsSweepHandler);
    enqueue = jest.spyOn(moduleRef.get(JobsService), 'enqueue');
  });

  beforeEach(() => {
    enqueue.mockReset();
    enqueue.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    enqueue.mockRestore();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('sends one email when both lines are cast, none before', async () => {
    const tenant = await freshTenant();
    const order = await placeOrder(tenant);

    await toCastRings(tenant, order);
    // Every move queues the job for the groups it touched, after it commits.
    expect(enqueue).toHaveBeenCalledWith('orders.progress', expect.objectContaining({ tenantId: tenant.id, groupIds: [order.lines[0]!.group_id] }));
    await expect(sendDue(tenant, order)).resolves.toBe(0);
    expect(await raised(tenant, order.id)).toEqual([]);

    await toCastPendant(tenant, order);
    await expect(sendDue(tenant, order)).resolves.toBe(1);
    expect(await raised(tenant, order.id)).toEqual([{ number: String(order.number), step: 'Casting' }]);
    expect(await recorded(tenant, order.id)).toEqual(['Casting']);

    // It goes to the customer's people.
    const reached = await prisma.inTenant(tenant.id, (tx) =>
      resolveAudience(tx, { tenantId: tenant.id, eventKey: 'order.progress', subjectType: 'order', subjectId: order.id }, settings),
    );
    expect(reached.map((target) => target.email)).toEqual([tenant.buyerEmail]);

    // Finishing is shown to customers but doesn't email; packing is hidden.
    await pass(tenant, order.lines[0]!.group_id, 'polishing', 'packing');
    await pass(tenant, order.lines[1]!.group_id, 'polishing', 'packing');
    await expect(sendDue(tenant, order)).resolves.toBe(0);
    expect(await raised(tenant, order.id)).toHaveLength(1);
  });

  it('never sends it again after a rework or a correction (Review Focus 4)', async () => {
    const tenant = await freshTenant();
    const order = await placeOrder(tenant);
    await toCastRings(tenant, order);
    await toCastPendant(tenant, order);
    await expect(sendDue(tenant, order)).resolves.toBe(1);

    // A ring fails polishing with porosity and goes back to casting, then is cast again.
    const [ring] = await piecesOf(tenant, order.lines[0]!.group_id);
    await move(tenant, { work_order_ids: [ring!.id], at_step: 'polishing', kind: 'fail', defect_id: tenant.cast.workflow.defects.porosity });
    await expect(sendDue(tenant, order)).resolves.toBe(0);
    await move(tenant, { work_order_ids: [ring!.id], at_step: 'casting', kind: 'pass' });
    await expect(sendDue(tenant, order)).resolves.toBe(0);

    // The pendant is put back before casting by mistake, and forward again.
    const [pendant] = await piecesOf(tenant, order.lines[1]!.group_id);
    await move(tenant, { work_order_ids: [pendant!.id], kind: 'correction', to_step: 'casting_tree', comment: 'Wrong piece' });
    await move(tenant, { work_order_ids: [pendant!.id], kind: 'correction', to_step: 'polishing', comment: 'Right piece after all' });
    await expect(sendDue(tenant, order)).resolves.toBe(0);

    expect(await raised(tenant, order.id)).toHaveLength(1);
  });

  it('waits for a reworked line, then sends once (Review Focus 4)', async () => {
    const tenant = await freshTenant();
    const order = await placeOrder(tenant);
    await toCastRings(tenant, order);
    // The pendant reaches casting, fails it with porosity and is cast again: one email, once both are cast.
    await pass(tenant, order.lines[1]!.group_id, 'print_pattern', 'casting_tree');
    const [pendant] = await piecesOf(tenant, order.lines[1]!.group_id);
    await move(tenant, { work_order_ids: [pendant!.id], at_step: 'wax_casting', kind: 'fail', defect_id: tenant.cast.workflow.defects.porosity });
    await expect(sendDue(tenant, order)).resolves.toBe(0);
    await move(tenant, { work_order_ids: [pendant!.id], at_step: 'wax_casting', kind: 'pass' });
    await expect(sendDue(tenant, order)).resolves.toBe(1);
    await expect(sendDue(tenant, order)).resolves.toBe(0);
    expect(await raised(tenant, order.id)).toHaveLength(1);
  });

  it('sends nothing to a customer on a plan without progress emails (Review Focus 5)', async () => {
    const tenant = await freshTenant();
    const order = await placeOrder(tenant);
    await toCastRings(tenant, order);

    // The plan loses the switch before the last piece is cast: read when the email would go out.
    await setProgressEmails(tenant.id, false);
    await toCastPendant(tenant, order);
    await expect(sendDue(tenant, order)).resolves.toBe(0);
    expect(await raised(tenant, order.id)).toEqual([]);
    // Nothing is recorded as sent, so the email still goes out once the plan has the switch again.
    expect(await recorded(tenant, order.id)).toEqual([]);

    await setProgressEmails(tenant.id, true);
    await expect(sendDue(tenant, order)).resolves.toBe(1);
  });

  it('sends nothing for a cancelled order, or for pieces started from a quote', async () => {
    const tenant = await freshTenant();
    const order = await placeOrder(tenant);
    await toCastRings(tenant, order);
    await toCastPendant(tenant, order);
    await tenant.staff.post(`/orders/${order.id}/cancel`, { reason: 'Customer phoned' }).expect(200);
    await expect(sendDue(tenant, order)).resolves.toBe(0);
    expect(await raised(tenant, order.id)).toEqual([]);

    // Pieces started from a quote alone have no order to tell anyone about.
    const quoteId = await tenant.quote(tenant.cast.productId, 1);
    const group = id(await tenant.staff.post('/workflow/groups', { quote_id: quoteId }).expect(201));
    await pass(tenant, group, 'print_pattern', 'casting_tree', 'casting');
    await expect(progress.sendDue(tenant.id, [group])).resolves.toBe(0);
  });

  it('catches up through the sweep when the job was never queued', async () => {
    const tenant = await freshTenant();
    const order = await placeOrder(tenant);
    // Queueing the progress job fails: the move still goes through, and the failure is only logged.
    enqueue.mockImplementation((name: string) =>
      name === 'orders.progress' ? Promise.reject(new Error('Redis is down')) : Promise.resolve(undefined),
    );
    await toCastRings(tenant, order);
    await toCastPendant(tenant, order);
    expect(await raised(tenant, order.id)).toEqual([]);

    await sweep.handle();
    expect(await raised(tenant, order.id)).toEqual([{ number: String(order.number), step: 'Casting' }]);
    await sweep.handle();
    expect(await raised(tenant, order.id)).toHaveLength(1);
  });

  it('refuses email on a hidden step', async () => {
    const tenant = await freshTenant();
    const hidden = { ...tenant.casting('wax_casting', 'Wax casting'), customer: { visible: false, email: true } };
    await tenant.staff.put(`/workflow/workflows/${tenant.pendantWorkflow}/steps`, { steps: tenant.workflowSteps(hidden) }).expect(400);

    // Left out, a visible step doesn't email.
    const plain = { ...tenant.casting('wax_casting', 'Wax casting'), customer: { visible: true, name: 'Casting' } };
    const version = await tenant.staff
      .put(`/workflow/workflows/${tenant.pendantWorkflow}/steps`, { steps: tenant.workflowSteps(plain) })
      .expect(200);
    expect((version.body as { steps: { key: string; customer: object }[] }).steps.find((step) => step.key === 'wax_casting')).toMatchObject({
      customer: { visible: true, name: 'Casting', email: false },
    });
  });

  it('records nothing when its notification cannot be written, and sends it on the next run (review fix)', async () => {
    const tenant = await freshTenant();
    const order = await placeOrder(tenant);
    await toCastRings(tenant, order);
    await toCastPendant(tenant, order);

    const store = jest.spyOn(notifications, 'store').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(sendDue(tenant, order)).rejects.toThrow('disk full');
      expect(await recorded(tenant, order.id)).toEqual([]);
      expect(await raised(tenant, order.id)).toEqual([]);

      await expect(sendDue(tenant, order)).resolves.toBe(1);
      expect(await raised(tenant, order.id)).toEqual([{ number: String(order.number), step: 'Casting' }]);
    } finally {
      store.mockRestore();
    }
  });

  it('leaves the notification pending for its sweeper when dispatch cannot be queued (review fix)', async () => {
    const tenant = await freshTenant();
    const order = await placeOrder(tenant);
    await toCastRings(tenant, order);
    await toCastPendant(tenant, order);

    enqueue.mockImplementation((name: string) =>
      name === 'notification.dispatch' ? Promise.reject(new Error('Redis is down')) : Promise.resolve(undefined),
    );
    await expect(sendDue(tenant, order)).resolves.toBe(1);
    const rows = await prisma.inTenant(tenant.id, (tx) =>
      tx.notification.findMany({ where: { eventKey: 'order.progress', subjectType: 'order', subjectId: order.id }, select: { status: true } }),
    );
    expect(rows).toEqual([{ status: 'pending' }]);
    expect(await recorded(tenant, order.id)).toEqual(['Casting']);
  });

  it('cancels an order while a move that drew one of its pieces commits, without a deadlock (final review)', async () => {
    const tenant = await freshTenant();
    const order = await placeOrder(tenant);
    const groupId = order.lines[0]!.group_id;

    // As a first arrival at a sampling step does: holds one piece and draws another, whose key is checked
    // at commit. The cancel locks the drawn piece first (lower id), then waits on the held one.
    let cancelled: Promise<request.Response> | undefined;
    const moving = prisma.inTenant(tenant.id, async (tx) => {
      const [drawnPiece, heldPiece] = await tx.workOrder.findMany({ where: { groupId }, orderBy: { id: 'asc' }, select: { id: true } });
      await tx.$queryRaw`SELECT id FROM work_order WHERE id = ${heldPiece!.id}::uuid FOR NO KEY UPDATE`;
      const group = await tx.workOrderGroup.findUniqueOrThrow({ where: { id: groupId } });
      const step = await tx.workflowStep.findFirstOrThrow({ where: { versionId: group.workflowVersionId } });
      const draw = await tx.sampleDraw.create({ data: { id: newId(), groupId, stepId: step.id } });
      await tx.samplePiece.create({ data: { drawId: draw.id, workOrderId: drawnPiece!.id } });
      cancelled = tenant.staff.post(`/orders/${order.id}/cancel`, { reason: 'Customer phoned' }).then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    await expect(moving).resolves.toBeUndefined();
    expect((await cancelled!).status).toBe(200);
  });

  it('counts a piece corrected past the emailed step (review fix)', async () => {
    const tenant = await freshTenant();
    const order = await placeOrder(tenant);
    await toCastRings(tenant, order);

    // The pendant is put forward past casting by a correction, so it never passes casting itself.
    await pass(tenant, order.lines[1]!.group_id, 'print_pattern', 'casting_tree');
    const [pendant] = await piecesOf(tenant, order.lines[1]!.group_id);
    await move(tenant, { work_order_ids: [pendant!.id], kind: 'correction', to_step: 'polishing', comment: 'Cast in the last batch' });

    await expect(sendDue(tenant, order)).resolves.toBe(1);
    expect(await raised(tenant, order.id)).toEqual([{ number: String(order.number), step: 'Casting' }]);
  });
});
