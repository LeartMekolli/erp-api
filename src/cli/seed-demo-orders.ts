import type { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import type { PartnerAuth, TenantAuth } from '../modules/identity/auth-context';
import type { TenantPermission } from '../modules/identity/permissions';
import type { CommentsService } from '../modules/orders/comments.service';
import { localDate, promisedDate, startOfLocalDay, workingDaysAfter, workingDaysBefore } from '../modules/orders/dates';
import type { BusinessCalendar } from '../modules/orders/dates';
import type { Address, OrderCountsResponse } from '../modules/orders/order-response';
import type { OrderStatesService } from '../modules/orders/order-states.service';
import type { OrdersService } from '../modules/orders/orders.service';
import { DEFAULT_CALENDAR } from '../modules/orders/place-order';
import type { JobsService } from '../modules/partners/jobs.service';
import type { InvoicesService } from '../modules/payments/invoices.service';
import type { PaidByHandService } from '../modules/payments/paid-by-hand.service';
import type { RefundsService } from '../modules/payments/refunds.service';
import type { QuotesService } from '../modules/pricing/quotes.service';
import { SettingsService } from '../modules/settings/settings.service';
import type { MoveBody, MovesService } from '../modules/workflow/moves.service';
import type { ChecklistItem, StepConfig } from '../modules/workflow/workflow-config';

// Demo orders for the demo workspace's Orders screen, on top of its customers, partners, catalog, pricing,
// workflows, ordering setup, couriers and payment terms (the other `seed-*.ts`): every tab, needs-you
// reason and payment state has an order. Each is quoted, placed, paid, offered to and accepted by its
// workshop (one offer is left unanswered), moved through every step, shipped, delivered, invoiced, cancelled and refunded through the
// services staff and partners use. Only the clock is the seed's: the services stamp each change with
// now, so once an order is done its own dates are moved back to when it would have happened, relative
// to the day the seed runs, and its states are stored again from the facts.

const NORTHCAST = 'Northcast Foundry';
const LAYERLINE = 'Layerline Prints';
const EMBERLINE = 'Emberline Casting';
const NORTHSIDE = 'Northside Architecture Models and Protos';

/** The demo customers this step adds, beside Luna Jewels and Mira Studio (`seed-customers.ts`) and Brightline (`seed-payments.ts`). */
const CUSTOMERS: { name: string; shipping: Address; terms: { daysToPay: number } | null }[] = [
  {
    name: 'Fieldnote Studio',
    shipping: { name: 'Fieldnote Studio', line1: 'Prinsengracht 12', city: 'Amsterdam', postal_code: '1015 DV', country: 'NL' },
    terms: null,
  },
  {
    name: 'Orbit Dental',
    shipping: { name: 'Orbit Dental', line1: 'Bahnhofstraße 8', city: 'München', postal_code: '80335', country: 'DE' },
    terms: { daysToPay: 14 },
  },
  {
    name: 'Kestrel Labs',
    shipping: { name: 'Kestrel Labs', line1: 'Rue de Rivoli 40', city: 'Paris', postal_code: '75004', country: 'FR' },
    terms: null,
  },
  {
    name: 'Halden Audio',
    shipping: { name: 'Halden Audio', line1: 'Storgata 5', city: 'Oslo', postal_code: '0155', country: 'NO' },
    terms: null,
  },
  {
    name: 'Pinewood Instruments',
    shipping: { name: 'Pinewood Instruments', line1: 'Calle Mayor 3', city: 'Madrid', postal_code: '28013', country: 'ES' },
    terms: { daysToPay: 30 },
  },
  // 40 characters: the longest name the staff app's layout is built for.
  {
    name: NORTHSIDE,
    shipping: { name: NORTHSIDE, line1: 'Nørregade 7', city: 'København', postal_code: '1165', country: 'DK' },
    terms: null,
  },
];

/**
 * Where a customer's orders go when it has no saved shipping address: Brightline never has one
 * (`seed-payments.ts`), and a demo seeded before addresses existed keeps its customers without one.
 */
const FALLBACK_ADDRESSES = new Map<string, Address>([
  ['Luna Jewels', { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' }],
  ['Mira Studio', { name: 'Mira Studio', line1: 'Via Roma 2', city: 'Milano', postal_code: '20121', country: 'IT' }],
  ['Brightline', { name: 'Brightline', line1: 'Kungsgatan 9', city: 'Stockholm', postal_code: '111 43', country: 'SE' }],
  ...CUSTOMERS.map((customer): [string, Address] => [customer.name, customer.shipping]),
]);

interface DemoLine {
  product: string;
  options?: Record<string, string>;
  size?: { scale: string } | { named: string };
  quantity: number;
}

const cast = (material: string, finish: string, scale: string, quantity: number): DemoLine => ({
  product: 'custom_cast_part',
  options: { material, finish },
  size: { scale },
  quantity,
});
const pendant = (material: string, finish: string, named: string, quantity: number): DemoLine => ({
  product: 'pendant_part',
  options: { material, finish },
  size: { named },
  quantity,
});
const print = (material: string, finish: string, scale: string, quantity: number): DemoLine => ({
  product: 'custom_resin_print',
  options: { material, finish },
  size: { scale },
  quantity,
});
const bail = (quantity: number): DemoLine => ({ product: 'bail_part', quantity });

/** Where an order is left. `waiting` is placed and not paid; `cancelled` is cancelled whole once paid, if it is paid. */
type Progress = 'waiting' | 'production' | 'ready' | 'shipped' | 'delivered' | 'cancelled';

interface DemoOrder {
  /** Found again by it: the order's `channel_order_id` is `demo:<key>`. */
  key: string;
  customer: string;
  lines: DemoLine[];
  shipping?: 'courier' | 'collect' | 'courier_live';
  /** Paid by bank transfer, recorded by hand; a pay-first customer's order waits for it. */
  paid?: boolean;
  /** Offered every line and accepts it once the order has started. */
  partner?: string;
  /** False: the partner is offered every line and never answers. */
  accepts?: false;
  progress: Progress;
  /** Working days from today the order is promised; a waiting order is promised as placed. */
  promised: number;
  /** A waiting order: placed this many hours ago, so it is still within its time to pay. */
  hoursAgo?: number;
  /** Lines cancelled with the refund suggested for them, the rest left in production. */
  cancelLines?: number[];
  /** Its first line's pieces fail checks on the way: one scrapped at casting, two sent back at polishing. */
  quality?: true;
  /** The line is moved to this partner part-way, after the first partner's moves. */
  handOver?: string;
}

/** The situations the Orders screen is tested with; the comment is what staff see. */
const ORDERS: DemoOrder[] = [
  // Late, in production.
  { key: 'late-in-production', customer: 'Fieldnote Studio', lines: [cast('silver_925', 'polished', '1', 12)], paid: true, partner: NORTHCAST, progress: 'production', promised: -2 },
  // In production with failures: a scrapped piece, two being redone, and a comment for each reader.
  { key: 'quality-issues', customer: 'Fieldnote Studio', lines: [cast('silver_925', 'polished', '1', 10)], paid: true, partner: NORTHCAST, progress: 'production', promised: 7, quality: true },
  // Late and ready: late, to ship.
  { key: 'late-ready', customer: 'Luna Jewels', lines: [pendant('silver_925', 'polished', 'M', 24)], paid: true, partner: NORTHCAST, progress: 'ready', promised: -1 },
  // Ready, promised tomorrow, on the live-rate method so a label can be bought with its defaults; pay later, not billed.
  { key: 'ready-label', customer: 'Orbit Dental', lines: [print('resin_standard', 'raw', '2', 6)], shipping: 'courier_live', partner: LAYERLINE, progress: 'ready', promised: 1 },
  // Ready, promised in two days.
  { key: 'ready-soon', customer: 'Mira Studio', lines: [pendant('gold_18k', 'polished', 'L', 2)], paid: true, partner: NORTHCAST, progress: 'ready', promised: 2 },
  // Ready for collection at the workshop: to ship (the API has no pickup reason of its own).
  { key: 'ready-collect', customer: 'Halden Audio', lines: [bail(50)], shipping: 'collect', paid: true, partner: LAYERLINE, progress: 'ready', promised: 3 },
  // Due today, in production.
  { key: 'due-today', customer: 'Luna Jewels', lines: [cast('brass', 'raw', '1.5', 30)], paid: true, partner: NORTHCAST, progress: 'production', promised: 0 },
  // Due in two days, in production; pay later, not billed.
  { key: 'due-soon', customer: 'Brightline', lines: [bail(30)], partner: LAYERLINE, progress: 'production', promised: 2 },
  // Awaiting payment: an assembly, so its parts' groups wait too.
  { key: 'awaiting-set', customer: 'Kestrel Labs', lines: [{ product: 'pendant_set', options: { material: 'silver_925', finish: 'polished' }, quantity: 1 }], progress: 'waiting', promised: 0, hoursAgo: 5 },
  // Awaiting payment.
  { key: 'awaiting-prints', customer: 'Halden Audio', lines: [print('pla', 'raw', '0.5', 200)], progress: 'waiting', promised: 0, hoursAgo: 2 },
  // Several lines, paid, in production, for the 40-character customer.
  {
    key: 'several-lines',
    customer: NORTHSIDE,
    lines: [print('resin_standard', 'polished', '1', 4), print('nylon_pa12', 'raw', '3', 1), bail(8)],
    paid: true,
    partner: LAYERLINE,
    progress: 'production',
    promised: 5,
  },
  // A five-digit total: gold, paid, in production.
  { key: 'large-total', customer: 'Mira Studio', lines: [cast('gold_18k', 'polished', '1.5', 5)], paid: true, partner: NORTHCAST, progress: 'production', promised: 4 },
  // Pay later, not billed, in production.
  { key: 'not-billed', customer: 'Brightline', lines: [print('resin_standard', 'raw', '1', 40)], partner: LAYERLINE, progress: 'production', promised: 6 },
  // Offered to its workshop, not answered yet.
  { key: 'offered', customer: 'Mira Studio', lines: [cast('silver_925', 'polished', '1', 8)], paid: true, partner: NORTHCAST, accepts: false, progress: 'production', promised: 6 },
  // Shipped yesterday on pay-later terms, invoiced, not due yet.
  { key: 'invoiced', customer: 'Orbit Dental', lines: [print('nylon_pa12', 'raw', '1.5', 10)], partner: LAYERLINE, progress: 'shipped', promised: 0 },
  // Shipped over a month ago on 30 days: the invoice is overdue, to collect.
  { key: 'overdue', customer: 'Pinewood Instruments', lines: [bail(40)], partner: LAYERLINE, progress: 'shipped', promised: -25 },
  // Shipped with the courier and tracking number, paid.
  { key: 'shipped', customer: 'Luna Jewels', lines: [pendant('brass', 'raw', 'S', 3)], paid: true, partner: NORTHCAST, progress: 'shipped', promised: -1 },
  // Delivered, paid.
  { key: 'delivered', customer: 'Kestrel Labs', lines: [cast('silver_925', 'raw', '0.5', 50)], paid: true, partner: NORTHCAST, progress: 'delivered', promised: -6 },
  // Cancelled once paid, everything refunded.
  { key: 'cancelled-refunded', customer: 'Halden Audio', lines: [print('pla', 'raw', '0.5', 100)], paid: true, progress: 'cancelled', promised: 7 },
  // Cancelled before it was paid: nothing to refund (payment state none).
  { key: 'cancelled-unpaid', customer: NORTHSIDE, lines: [print('pla', 'raw', '1', 20)], progress: 'cancelled', promised: 9 },
  // Paid, one of its two lines cancelled with its refund: partly refunded, the other line in production.
  {
    key: 'partly-refunded',
    customer: 'Fieldnote Studio',
    lines: [print('resin_standard', 'raw', '1', 10), bail(10)],
    paid: true,
    partner: LAYERLINE,
    progress: 'production',
    promised: 8,
    cancelLines: [1],
  },
  // In production, handed from one foundry to another after a failure: the second one's History shows the first one's moves.
  { key: 'handed-over', customer: 'Kestrel Labs', lines: [cast('silver_925', 'polished', '1', 6)], paid: true, partner: NORTHCAST, progress: 'production', promised: 8, handOver: EMBERLINE },
];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FINISHED: Progress[] = ['ready', 'shipped', 'delivered'];
const SHIPPED: Progress[] = ['shipped', 'delivered'];
const COMMENT = 'Checked for the demo';

const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
const addDays = (day: string, days: number) => new Date(asDate(day).getTime() + days * DAY_MS).toISOString().slice(0, 10);

export interface DemoOrdersDeps {
  prisma: PrismaService;
  quotes: QuotesService;
  orders: OrdersService;
  states: OrderStatesService;
  paidByHand: PaidByHandService;
  refunds: RefundsService;
  invoices: InvoicesService;
  jobs: JobsService;
  moves: MovesService;
  comments: CommentsService;
}

export interface DemoOrdersSeed {
  customers: number;
  orders: number;
  /** Shipped pay-later orders left not billed: the workspace has no payment account to invoice through. */
  notInvoiced: number;
  /** The workspace's tab and needs-you counts once seeded, as `GET /orders/counts` gives them. */
  counts: OrderCountsResponse;
}

/** What the plan of an order's dates is worked out from. */
interface Clock {
  now: Date;
  today: string;
  timezone: string;
  calendar: BusinessCalendar;
  speedDays: number;
}

/** When each fact of an order would have happened. */
interface Timeline {
  placedAt: Date;
  startedAt: Date | null;
  promisedOn: string;
  shippedAt: Date | null;
  deliveredAt: Date | null;
}

/**
 * The order's dates: promised `promised` working days from today, started the default speed's working
 * days before (placed at 09:15, a pay-first order paid at 10:40), shipped the working day before its
 * promise and delivered on it. A waiting order is placed `hoursAgo` hours ago and promised as placed.
 */
function demoTimeline(order: DemoOrder, clock: Clock): Timeline {
  const at = (day: string, hour: number, minute: number) => new Date(startOfLocalDay(day, clock.timezone).getTime() + (hour * 60 + minute) * 60_000);
  if (order.progress === 'waiting') {
    const placedAt = new Date(clock.now.getTime() - (order.hoursAgo ?? 1) * HOUR_MS);
    return { placedAt, startedAt: null, promisedOn: promisedDate(placedAt, clock.speedDays, clock.calendar, clock.timezone), shippedAt: null, deliveredAt: null };
  }
  const promisedOn =
    order.promised < 0 ? workingDaysBefore(clock.today, -order.promised, clock.calendar) : workingDaysAfter(clock.today, order.promised, clock.calendar);
  const startDay = workingDaysBefore(promisedOn, clock.speedDays, clock.calendar);
  const placedAt = at(startDay, 9, 15);
  const shipDay = workingDaysBefore(promisedOn, 1, clock.calendar);
  return {
    placedAt,
    startedAt: order.paid ? at(startDay, 10, 40) : placedAt,
    promisedOn,
    shippedAt: SHIPPED.includes(order.progress) ? at(shipDay, 15, 30) : null,
    deliveredAt: order.progress === 'delivered' ? at(promisedOn, 11, 0) : null,
  };
}

/** A value that passes a checklist item. */
function passingValue(item: ChecklistItem): string | boolean {
  switch (item.kind) {
    case 'choice':
      return item.options.find((option) => option.passing)!.key;
    case 'yes_no':
      return item.passing_answer;
    case 'number':
      return item.min ?? item.max ?? '0';
    case 'text':
      return COMMENT;
  }
}

/**
 * Seeds the demo orders into one workspace that has the rest of the demo, acting as `staffUserId` and as
 * each workshop's owner. Idempotent: a customer is found by name and its terms by customer, as the other
 * steps do, and an order by its `channel_order_id`; anything found is left as it is. Orders are made
 * oldest first, so their numbers and ids follow when they were placed. A shipped pay-later order is
 * invoiced only when the workspace has a payment account (`DEMO_STRIPE_*`, `seed-payments.ts`).
 */
export async function seedDemoOrders(deps: DemoOrdersDeps, tenantId: string, staffUserId: string): Promise<DemoOrdersSeed> {
  const { prisma } = deps;
  let customers = 0;
  await prisma.inTenant(tenantId, async (tx) => {
    for (const seed of CUSTOMERS) {
      let customer = await tx.customer.findFirst({ where: { name: seed.name } });
      if (!customer) {
        customer = await tx.customer.create({ data: { name: seed.name, shippingAddress: seed.shipping as Prisma.InputJsonValue } });
        customers++;
      }
      if (seed.terms && !(await tx.customerPaymentTerms.findUnique({ where: { customerId: customer.id } }))) {
        await tx.customerPaymentTerms.create({ data: { customerId: customer.id, terms: 'pay_later', daysToPay: seed.terms.daysToPay, creditLimit: null } });
      }
    }
  });

  const context = await prisma.inTenant(tenantId, async (tx) => {
    const settings = await new SettingsService().list(tx);
    const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
    const speed = await tx.deliverySpeed.findFirst({ where: { isDefault: true }, select: { workingDays: true } });
    const customerRows = await tx.customer.findMany({ where: { name: { in: [...new Set(ORDERS.map((order) => order.customer))] } } });
    const products = await tx.product.findMany({ where: { key: { in: [...new Set(ORDERS.flatMap((order) => order.lines.map((line) => line.product)))] } } });
    const partners = await tx.partner.findMany({ where: { name: { in: [NORTHCAST, LAYERLINE, EMBERLINE] } }, select: { id: true, name: true } });
    const owners = await tx.organisationMembership.findMany({
      where: { organisationType: 'partner', organisationId: { in: partners.map((partner) => partner.id) }, role: 'owner' },
      select: { organisationId: true, userId: true },
    });
    const defects = await tx.defect.findMany({ where: { key: { in: ['crack', 'scratch', 'porosity'] } }, select: { id: true, key: true } });
    const existing = await tx.order.findMany({
      where: { channel: 'staff', channelOrderId: { in: ORDERS.map((order) => `demo:${order.key}`) } },
      select: { channelOrderId: true },
    });
    return {
      clock: {
        now: new Date(),
        today: await deps.states.today(tx, tenantId),
        timezone,
        calendar: (settings['business.calendar'] as BusinessCalendar | undefined) ?? DEFAULT_CALENDAR,
        speedDays: speed?.workingDays ?? 0,
      },
      bufferDays: (settings['orders.scheduling'] as { bufferDays: number } | undefined)?.bufferDays ?? 2,
      customers: new Map(customerRows.map((row) => [row.name, { id: row.id, hasAddress: row.shippingAddress !== null }])),
      products: new Map(products.map((row) => [row.key, row])),
      partners: new Map(partners.map((row) => [row.name, { id: row.id, ownerId: owners.find((owner) => owner.organisationId === row.id)?.userId }])),
      // The placeholder design: the custom products are quoted on it, and final QC's photo is it.
      designId: products.find((row) => row.key === 'pendant_part')?.fileVersionId ?? null,
      defects: new Map(defects.map((row) => [row.key, row.id])),
      paymentAccount: (await tx.paymentAccount.findFirst({ select: { tenantId: true } })) !== null,
      existing: new Set(existing.map((row) => row.channelOrderId)),
    };
  });
  const missing = [
    ...ORDERS.flatMap((order) => (context.customers.has(order.customer) ? [] : [order.customer])),
    ...ORDERS.flatMap((order) => order.lines.flatMap((line) => (context.products.has(line.product) ? [] : [line.product]))),
    ...[NORTHCAST, LAYERLINE, EMBERLINE].filter((name) => !context.partners.get(name)?.ownerId),
    ...(context.designId ? [] : ['the placeholder design']),
    ...['crack', 'scratch', 'porosity'].filter((key) => !context.defects.has(key)).map((key) => `the ${key} defect`),
  ];
  if (missing.length > 0) {
    throw new Error(`Demo orders need the rest of the demo first; missing: ${[...new Set(missing)].join(', ')}`);
  }

  const staff: TenantAuth = {
    scope: 'tenant',
    tenantId,
    userId: staffUserId,
    jti: 'seed',
    expiresAt: new Date(Date.now() + HOUR_MS),
    // Cancelling a paid order refunds it, which needs this permission.
    permissions: new Set<TenantPermission>(['payment.refund']),
  };
  const designId = context.designId!;

  /** Passes the group's pieces through every step of their path, a step at a time, as staff at the workshop's steps. */
  const finishPieces = async (groupId: string) => {
    for (let round = 0; round < 50; round++) {
      const next = await prisma.inTenant(tenantId, async (tx) => {
        const pieces = await tx.workOrder.findMany({ where: { groupId, status: 'active' }, include: { currentStep: true } });
        const steps = pieces.flatMap((piece) => (piece.currentStep ? [piece.currentStep] : []));
        if (steps.length === 0) return null;
        const step = steps.reduce((first, candidate) => (candidate.position < first.position ? candidate : first));
        return { step, ids: pieces.filter((piece) => piece.currentStepId === step.id).map((piece) => piece.id) };
      });
      if (!next) return;
      const config = next.step.config as StepConfig;
      if (config.pass.min_photos > 1) {
        throw new Error(`Demo orders attach one photo; step ${next.step.key} needs ${config.pass.min_photos}`);
      }
      await deps.moves.move(staff, {
        work_order_ids: next.ids,
        kind: 'pass',
        at_step: next.step.key,
        answers: config.checklist.filter((item) => item.required).map((item) => ({ item: item.key, value: passingValue(item) })),
        ...(config.pass.min_photos > 0 ? { photo_file_version_ids: [designId] } : {}),
        ...(config.pass.comment_required ? { comment: COMMENT } : {}),
        inspected: true,
      });
    }
    throw new Error(`The pieces of group ${groupId} did not finish`);
  };

  /**
   * Takes the group's pieces as far as polishing with failures on the way: the first cracks at casting and
   * is scrapped (its replacement starts again at the first step), the next two are scratched at polishing
   * and sent back to be polished again, and the other seven pass.
   */
  const failSome = async (groupId: string) => {
    const ids = (
      await prisma.inTenant(tenantId, (tx) => tx.workOrder.findMany({ where: { groupId }, orderBy: { id: 'asc' }, select: { id: true } }))
    ).map((piece) => piece.id);
    const move = (workOrderIds: string[], atStep: string, extra: Partial<MoveBody> = {}) =>
      deps.moves.move(staff, { work_order_ids: workOrderIds, at_step: atStep, kind: 'pass', inspected: true, ...extra });
    await move(ids, 'print_pattern');
    await move(ids, 'casting_tree');
    await move(ids.slice(0, 1), 'casting', { kind: 'fail', defect_id: context.defects.get('crack')!, comment: COMMENT });
    await move(ids.slice(1), 'casting');
    await move(ids.slice(1, 3), 'polishing', {
      kind: 'fail',
      defect_id: context.defects.get('scratch')!,
      comment: COMMENT,
      photo_file_version_ids: [designId],
      answers: [{ item: 'surface', value: 'pitted' }],
    });
    await move(ids.slice(3), 'polishing', { answers: [{ item: 'surface', value: 'ok' }] });
  };

  /**
   * Takes the group's pieces from the first partner to the one it is handed to: the first partner passes all
   * at the first two steps and fails the first two at casting (porosity, redone there), staff pass the other
   * four at casting and move the job, and the second partner polishes those four.
   */
  const handOver = async (groupId: string, from: string, to: string) => {
    const ids = (
      await prisma.inTenant(tenantId, (tx) => tx.workOrder.findMany({ where: { groupId }, orderBy: { id: 'asc' }, select: { id: true } }))
    ).map((piece) => piece.id);
    const owner = (name: string) => {
      const partner = context.partners.get(name)!;
      const auth: PartnerAuth = { tenantId, userId: partner.ownerId!, partnerId: partner.id, role: 'owner' };
      return { auth, scope: { partnerId: partner.id } };
    };
    const first = owner(from);
    const second = owner(to);
    const move = (who: ReturnType<typeof owner> | null, workOrderIds: string[], atStep: string, extra: Partial<MoveBody> = {}) =>
      who
        ? deps.moves.move(who.auth, { work_order_ids: workOrderIds, at_step: atStep, kind: 'pass', inspected: true, ...extra }, who.scope)
        : deps.moves.move(staff, { work_order_ids: workOrderIds, at_step: atStep, kind: 'pass', inspected: true, ...extra });
    await move(first, ids, 'print_pattern');
    await move(first, ids, 'casting_tree');
    await move(first, ids.slice(0, 2), 'casting', { kind: 'fail', defect_id: context.defects.get('porosity')!, comment: COMMENT });
    await move(null, ids.slice(2), 'casting');
    await deps.jobs.reassign(staff, groupId, { partner_id: context.partners.get(to)!.id });
    await move(second, ids.slice(2), 'polishing', { answers: [{ item: 'surface', value: 'ok' }] });
  };

  const plan = ORDERS.filter((order) => !context.existing.has(`demo:${order.key}`))
    .map((order) => ({ order, timeline: demoTimeline(order, context.clock) }))
    .sort((a, b) => a.timeline.placedAt.getTime() - b.timeline.placedAt.getTime());
  let notInvoiced = 0;

  for (const { order, timeline } of plan) {
    const customer = context.customers.get(order.customer)!;
    const customerId = customer.id;
    const quoteIds: string[] = [];
    for (const line of order.lines) {
      const product = context.products.get(line.product)!;
      const result = await deps.quotes.create(
        staff,
        {
          product_id: product.id,
          options: line.options ?? {},
          ...(line.size ? { size: line.size } : {}),
          quantity: line.quantity,
          ...(product.kind === 'custom' ? { file_version_id: designId } : {}),
        },
        { customerId, audience: 'staff' },
      );
      if (!result.accepted) {
        throw new Error(`Demo order ${order.key}: ${line.product} can't be quoted: ${result.reasons.map((reason) => reason.message).join('; ')}`);
      }
      quoteIds.push(result.quote.id);
    }
    const placed = await deps.orders.place(
      staff,
      customerId,
      {
        lines: quoteIds.map((id) => ({ quote_id: id })),
        shipping_method: order.shipping ?? 'courier',
        channel_order_id: `demo:${order.key}`,
        // The customer's saved address when it has one, as staff would leave it; else the fallback.
        ...(customer.hasAddress ? {} : { address: FALLBACK_ADDRESSES.get(order.customer)! }),
      },
      'staff',
    );
    const id = placed.id;

    if (order.paid) {
      await deps.paidByHand.record(staff, id, { reference: `Bank transfer for order ${placed.number}`, received_on: localDate(timeline.startedAt!, context.clock.timezone) });
    }
    if (order.partner) {
      const partner = context.partners.get(order.partner)!;
      const partnerAuth: PartnerAuth = { tenantId, userId: partner.ownerId!, partnerId: partner.id, role: 'owner' };
      for (const line of (await deps.orders.get(tenantId, id)).lines) {
        if (!line.group_id) continue;
        await deps.jobs.offer(staff, line.group_id, partner.id);
        if (order.accepts !== false) await deps.jobs.accept(partnerAuth, line.group_id);
      }
    }
    if (order.handOver) {
      await handOver(placed.lines[0].group_id!, order.partner!, order.handOver);
    }
    if (order.quality) {
      await failSome(placed.lines[0].group_id!);
      // One comment for each reader: the customer, the partner that has accepted the line, and staff alone.
      const say = (body: string, visibility: 'customer' | 'partner' | 'staff', lineId?: string) =>
        deps.comments.staffPost({ tenantId, userId: staffUserId }, id, { body, visibility, ...(lineId ? { line_id: lineId } : {}) });
      await say('We have had to remake one piece, the order is still on time.', 'customer');
      await say('Please check the polish on the next batch.', 'partner', placed.lines[0].id);
      await say('Keep an eye on this line, two pieces are being redone.', 'staff');
    }
    if (FINISHED.includes(order.progress)) {
      for (const line of placed.lines) {
        if (line.group_id) await finishPieces(line.group_id);
      }
    }
    if (SHIPPED.includes(order.progress)) {
      await deps.orders.ship(staff, id, { courier: 'DHL', tracking: `JD0146${String(placed.number).padStart(8, '0')}` });
      if (placed.payment.terms === 'pay_later') {
        // Ship queues the invoice for the worker; it is made now, so its due date can be moved below.
        if (context.paymentAccount) await deps.invoices.create(tenantId, id);
        else notInvoiced++;
      }
    }
    if (order.progress === 'delivered') {
      await deps.orders.deliver(staff, id);
    }
    if (order.progress === 'cancelled') {
      const suggestion = await deps.refunds.suggestion(tenantId, id, undefined);
      const paid = order.paid ? { refund: { amount: suggestion.paid_left } } : {};
      await deps.orders.cancel(staff, id, { reason: 'The customer changed their mind', ...paid });
    }
    if (order.cancelLines) {
      const suggestion = await deps.refunds.suggestion(tenantId, id, order.cancelLines);
      await deps.orders.cancel(staff, id, {
        reason: 'The customer no longer needs this line',
        lines: order.cancelLines,
        refund: { amount: suggestion.suggested },
      });
    }

    // The clock: the order's dates as they would have been, its jobs due its promise less the buffer, its
    // invoice due its days to pay after it shipped, then both states stored again from the facts.
    await prisma.inTenant(tenantId, async (tx) => {
      const row = await tx.order.findUniqueOrThrow({ where: { id } });
      const shift = row.placedAt.getTime() - timeline.placedAt.getTime();
      await tx.order.update({
        where: { id },
        data: {
          placedAt: timeline.placedAt,
          promisedOn: asDate(timeline.promisedOn),
          productionStartedAt: row.productionStartedAt ? timeline.startedAt : null,
          payBy: row.payBy ? new Date(row.payBy.getTime() - shift) : null,
          shippedAt: row.shippedAt ? timeline.shippedAt : null,
          deliveredAt: row.deliveredAt ? timeline.deliveredAt : null,
        },
      });
      const lines = await tx.orderLine.findMany({ where: { orderId: id }, select: { groupId: true, parts: { select: { groupId: true } } } });
      const groupIds = lines.flatMap((line) => [line.groupId, ...line.parts.map((part) => part.groupId)]).flatMap((groupId) => (groupId ? [groupId] : []));
      await tx.jobAssignment.updateMany({
        where: { groupId: { in: groupIds }, status: { in: ['offered', 'accepted'] } },
        data: { dueOn: asDate(workingDaysBefore(timeline.promisedOn, context.bufferDays, context.clock.calendar)) },
      });
      // An offer left unanswered stays open for 30 days, so the offer expiry job doesn't lapse it a day after seeding.
      if (order.accepts === false) {
        await tx.jobAssignment.updateMany({
          where: { groupId: { in: groupIds }, status: 'offered' },
          data: { expiresAt: new Date(Date.now() + 30 * DAY_MS) },
        });
      }
      const invoice = await tx.invoice.findFirst({ where: { orderId: id, status: 'open' } });
      const terms = await tx.customerPaymentTerms.findUnique({ where: { customerId } });
      if (invoice && timeline.shippedAt && terms) {
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { dueOn: asDate(addDays(localDate(timeline.shippedAt, context.clock.timezone), terms.daysToPay)) },
        });
      }
      await deps.states.refresh(tx, [id]);
    });
  }

  return { customers, orders: plan.length, notInvoiced, counts: await deps.orders.counts(tenantId, {}) };
}
