import { newId } from '../common/ids/uuid';
import type { PrismaService } from '../database/prisma.service';
import type { PartnerAuth, TenantAuth } from '../modules/identity/auth-context';
import { Prisma } from '../generated/prisma/client';
import { isOpen, localDate, startOfLocalDay, workingDaysAfter, workingDaysBefore } from '../modules/orders/dates';
import type { BusinessCalendar } from '../modules/orders/dates';
import type { OrdersService } from '../modules/orders/orders.service';
import { DEFAULT_CALENDAR } from '../modules/orders/place-order';
import type { OrderStatesService } from '../modules/orders/order-states.service';
import type { JobsService } from '../modules/partners/jobs.service';
import { owedBetween } from '../modules/partners/owed-dates';
import type { OwedEntry } from '../modules/partners/owed-dates';
import type { PaidByHandService } from '../modules/payments/paid-by-hand.service';
import type { QuotesService } from '../modules/pricing/quotes.service';
import { SettingsService } from '../modules/settings/settings.service';
import { nextMonthStart } from '../modules/reporting/range-buckets';
import { addDays } from '../modules/reporting/week-metrics';
import { pathFor } from '../modules/workflow/path';
import type { StepConfig } from '../modules/workflow/workflow-config';
import { chainOf, stepsForPath } from '../modules/workflow/work-orders.service';
import { FALLBACK_ADDRESSES } from './seed-demo-orders';
import { randomFrom } from './seed-random';

// A year of finished demo orders for the dashboards, on top of the demo orders (`seed-demo-orders.ts`):
// about three to six a week over the 52 weeks that end two weeks before `now`, busier in some months. Each
// is quoted, placed, paid by hand and accepted by its workshop through the services. The services stamp
// every change with the real clock and moves are append-only, so the pieces' moves are written directly
// with their real past dates (passing every step, one piece in eight sent back from its check step with a
// defect and redone), and the order's own dates are moved back as the demo orders' are. The notifications the
// services raise for these year-old orders are removed again in the same pass. Each month's owed jobs are then
// paid in one payout per partner. Random choices come from a fixed seed, so a run is reproducible. Only the
// six pay-first customers are used: their orders start at once on a payment by hand, with no credit hold or
// invoice to date back; the pay-later customers' orders are in the demo orders already.

const NORTHCAST = 'Northcast Foundry';
const LAYERLINE = 'Layerline Prints';
const EMBERLINE = 'Emberline Casting';
/** Pay-first demo customers: their orders are paid by hand and start at once. */
const CUSTOMERS = ['Fieldnote Studio', 'Kestrel Labs', 'Halden Audio', 'Northside Architecture Models and Protos', 'Luna Jewels', 'Mira Studio'];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const WEEKS = 52;
/** The history's last placing day, this many days before `now`, so every order is delivered by then. */
const LAG_DAYS = 14;
/** Working days an order is promised after the day it is placed. */
const PROMISE_DAYS = 5;
/** Orders a week by month (January first); a week gets one more about two times in five, at most six. */
const BUSY = [3, 3, 4, 4, 4, 4, 3, 3, 4, 5, 6, 5];
const HISTORY_PREFIX = 'history:';
const TARGET = { onTimeRate: 0.9 };

interface LineTemplate {
  product: string;
  options?: Record<string, string>;
  size?: { scale: string } | { named: string };
  quantities: number[];
  partners: string[];
}

/** Lines the demo orders already use, so each can be quoted and made by the demo's partners. */
const LINES: LineTemplate[] = [
  { product: 'custom_cast_part', options: { material: 'silver_925', finish: 'polished' }, size: { scale: '1' }, quantities: [4, 6, 8, 10, 12], partners: [NORTHCAST, EMBERLINE] },
  { product: 'custom_cast_part', options: { material: 'silver_925', finish: 'raw' }, size: { scale: '0.5' }, quantities: [20, 30, 50], partners: [NORTHCAST] },
  { product: 'custom_cast_part', options: { material: 'brass', finish: 'raw' }, size: { scale: '1.5' }, quantities: [10, 20, 30], partners: [NORTHCAST] },
  { product: 'custom_cast_part', options: { material: 'gold_18k', finish: 'polished' }, size: { scale: '1.5' }, quantities: [2, 3, 5], partners: [NORTHCAST] },
  { product: 'pendant_part', options: { material: 'silver_925', finish: 'polished' }, size: { named: 'M' }, quantities: [12, 24], partners: [NORTHCAST] },
  { product: 'pendant_part', options: { material: 'brass', finish: 'raw' }, size: { named: 'S' }, quantities: [3, 6, 10], partners: [NORTHCAST] },
  { product: 'pendant_part', options: { material: 'gold_18k', finish: 'polished' }, size: { named: 'L' }, quantities: [2, 4], partners: [NORTHCAST] },
  { product: 'custom_resin_print', options: { material: 'resin_standard', finish: 'raw' }, size: { scale: '2' }, quantities: [6, 10, 20], partners: [LAYERLINE] },
  { product: 'custom_resin_print', options: { material: 'resin_standard', finish: 'polished' }, size: { scale: '1' }, quantities: [4, 8], partners: [LAYERLINE] },
  { product: 'custom_resin_print', options: { material: 'nylon_pa12', finish: 'raw' }, size: { scale: '1.5' }, quantities: [10, 20], partners: [LAYERLINE] },
  { product: 'custom_resin_print', options: { material: 'pla', finish: 'raw' }, size: { scale: '0.5' }, quantities: [50, 100, 200], partners: [LAYERLINE] },
  { product: 'bail_part', quantities: [30, 50, 80], partners: [LAYERLINE] },
];

export interface HistoryDeps {
  prisma: PrismaService;
  quotes: QuotesService;
  orders: OrdersService;
  states: OrderStatesService;
  paidByHand: PaidByHandService;
  jobs: JobsService;
}

export interface HistorySeed {
  orders: number;
  /** Payouts made, the pending one included. */
  payouts: number;
  /** The history's payouts pending after the run: 1, the newest, or 0 when there are none. */
  pending: number;
}

const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

interface PlannedOrder {
  key: string;
  /** Its place in the plan, from 0; with a piece's place in the order it decides which pieces fail the check. */
  index: number;
  day: string;
  slot: number;
  customer: string;
  template: LineTemplate;
  quantity: number;
  partner: string;
  /** Its last steps are done after the promised date. */
  late: boolean;
}

/** One move of one or more pieces, by step index on the path. */
interface Move {
  pieceIds: string[];
  kind: 'pass' | 'fail';
  from: number;
  /** The step index the pieces land on; null after the last step. */
  to: number | null;
  day: string;
}

/**
 * Seeds a year of finished demo orders into one workspace that has the demo orders, with `now` as today, and
 * the on-time target. Idempotent and resumable: the target is set only when unset; an order whose key
 * (`history:<n>`) is already delivered is skipped, and one left part-way by a crashed run is finished from
 * where it stopped; the payouts are made only for what is still owed. A workspace with older orders that
 * aren't the history's is left alone, and so is one whose finished history isn't the plan of this `now`
 * (a run on a later day): it gets no more orders.
 */
export async function seedHistory(deps: HistoryDeps, tenantId: string, now: Date): Promise<HistorySeed> {
  const { prisma } = deps;
  const setup = await prisma.inTenant(tenantId, async (tx) => {
    if (!(await tx.tenantSetting.findFirst({ where: { key: 'reports.targets' } }))) {
      await new SettingsService().set(tx, 'reports.targets', TARGET);
    }
    // Orders from before the history's year that it didn't make: this isn't a workspace to add a history to.
    const foreign = await tx.order.count({
      where: {
        placedAt: { lt: new Date(now.getTime() - 60 * DAY_MS) },
        OR: [{ channelOrderId: null }, { NOT: { channelOrderId: { startsWith: HISTORY_PREFIX } } }],
      },
    });
    if (foreign > 0) return null;
    const made = await tx.order.findMany({
      where: { channelOrderId: { startsWith: HISTORY_PREFIX }, deliveredAt: { not: null } },
      select: { channelOrderId: true, placedAt: true },
    });
    const settings = await new SettingsService().list(tx);
    const { timezone, defaultCurrency } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, defaultCurrency: true } });
    const customers = await tx.customer.findMany({ where: { name: { in: CUSTOMERS } } });
    const products = await tx.product.findMany({ where: { key: { in: [...new Set(LINES.map((line) => line.product))] } } });
    const partners = await tx.partner.findMany({ where: { name: { in: [NORTHCAST, LAYERLINE, EMBERLINE] } }, select: { id: true, name: true } });
    const owners = await tx.organisationMembership.findMany({
      where: { organisationType: 'partner', organisationId: { in: partners.map((partner) => partner.id) }, role: 'owner' },
      select: { organisationId: true, userId: true },
    });
    const designs = await tx.fileVersion.findMany({
      where: { file: { kind: 'design', ownerType: 'customer', ownerId: { in: customers.map((customer) => customer.id) } } },
      orderBy: { number: 'asc' },
      select: { id: true, file: { select: { ownerId: true } } },
    });
    const staff = await tx.user.findFirst({ where: { kind: 'staff' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
    return {
      timezone,
      currency: defaultCurrency,
      made: made.map((row) => ({ key: row.channelOrderId!, placedAt: row.placedAt })),
      calendar: (settings['business.calendar'] as BusinessCalendar | undefined) ?? DEFAULT_CALENDAR,
      bufferDays: (settings['orders.scheduling'] as { bufferDays: number } | undefined)?.bufferDays ?? 2,
      customers: new Map(customers.map((row) => [row.name, { id: row.id, hasAddress: row.shippingAddress !== null }])),
      products: new Map(products.map((row) => [row.key, row])),
      partners: new Map(partners.map((row) => [row.name, { id: row.id, ownerId: owners.find((owner) => owner.organisationId === row.id)?.userId }])),
      designs: new Map(designs.map((row) => [row.file.ownerId, row.id])),
      staffUserId: staff?.id,
    };
  });
  if (!setup) return { orders: 0, payouts: 0, pending: 0 };

  const missing = [
    ...CUSTOMERS.filter((name) => !setup.customers.has(name)),
    ...LINES.filter((line) => !setup.products.has(line.product)).map((line) => line.product),
    ...[NORTHCAST, LAYERLINE, EMBERLINE].filter((name) => !setup.partners.get(name)?.ownerId),
    ...(setup.staffUserId ? [] : ['a staff user']),
    ...CUSTOMERS.filter((name) => setup.customers.has(name) && !setup.designs.has(setup.customers.get(name)!.id)).map((name) => `${name}'s design`),
  ];
  if (missing.length > 0) {
    throw new Error(`The demo history needs the demo orders first; missing: ${[...new Set(missing)].join(', ')}`);
  }

  const { timezone, calendar } = setup;
  const staffUserId = setup.staffUserId!;
  const staff: TenantAuth = {
    scope: 'tenant',
    tenantId,
    userId: staffUserId,
    jti: 'seed',
    expiresAt: new Date(Date.now() + HOUR_MS),
    permissions: new Set(),
  };
  const at = (day: string, minutes: number) => new Date(startOfLocalDay(day, timezone).getTime() + minutes * MINUTE_MS);

  // The plan: 52 whole weeks (Monday to Sunday), the last holding the history's last placing day.
  const random = randomFrom(20_261_022);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  const lastDay = localDate(new Date(now.getTime() - LAG_DAYS * DAY_MS), timezone);
  const lastMonday = addDays(lastDay, -((asDate(lastDay).getUTCDay() + 6) % 7));
  const planned: Omit<PlannedOrder, 'key' | 'index' | 'late'>[] = [];
  for (let week = 0; week < WEEKS; week++) {
    const monday = addDays(lastMonday, (week - (WEEKS - 1)) * 7);
    const days = Array.from({ length: 7 }, (_, index) => addDays(monday, index)).filter((day) => day <= lastDay && isOpen(day, calendar));
    if (days.length === 0) continue;
    const count = Math.min(6, BUSY[Number(monday.slice(5, 7)) - 1] + (random() < 0.4 ? 1 : 0));
    const used = new Map<string, number>();
    for (let index = 0; index < count; index++) {
      const day = pick(days);
      const slot = used.get(day) ?? 0;
      used.set(day, slot + 1);
      const template = pick(LINES);
      planned.push({ day, slot, customer: pick(CUSTOMERS), template, quantity: pick(template.quantities), partner: pick(template.partners) });
    }
  }
  // Oldest first, so the numbers follow the dates; one order in ten is late.
  const plan: PlannedOrder[] = planned
    .sort((a, b) => (a.day === b.day ? a.slot - b.slot : a.day < b.day ? -1 : 1))
    .map((order, index) => ({ ...order, index, key: `${HISTORY_PREFIX}${index + 1}`, late: index % 10 === 7 }));

  // The history already made is the plan of this `now` only when every finished order sits on its planned
  // day; otherwise (a later day's plan) nothing more is made, and only the payouts are looked at.
  const made = new Map(setup.made.map((row) => [row.key, localDate(row.placedAt, timezone)]));
  const byKey = new Map(plan.map((order) => [order.key, order]));
  const sameHistory = [...made].every(([key, day]) => byKey.get(key)?.day === day);
  const todo = sameHistory ? plan.filter((order) => !made.has(order.key)) : [];

  const customerDesign = (customerId: string) => setup.designs.get(customerId)!;
  let orders = 0;

  for (const order of todo) {
    const customer = setup.customers.get(order.customer)!;
    const partner = setup.partners.get(order.partner)!;
    const product = setup.products.get(order.template.product)!;
    const partnerAuth: PartnerAuth = { tenantId, userId: partner.ownerId!, partnerId: partner.id, role: 'owner' };

    // An order a crashed run placed but didn't finish: carry on from what it has.
    const begun = await prisma.inTenant(tenantId, (tx) =>
      tx.order.findFirst({
        where: { channelOrderId: order.key },
        select: { id: true, number: true, productionStartedAt: true, lines: { orderBy: { position: 'asc' }, take: 1, select: { groupId: true } } },
      }),
    );
    let placed: { id: string; number: number; groupId: string };
    if (begun) {
      placed = { id: begun.id, number: begun.number, groupId: begun.lines[0].groupId! };
    } else {
      const quoted = await deps.quotes.create(
        staff,
        {
          product_id: product.id,
          options: order.template.options ?? {},
          ...(order.template.size ? { size: order.template.size } : {}),
          quantity: order.quantity,
          ...(product.kind === 'custom' ? { file_version_id: customerDesign(customer.id) } : {}),
        },
        { customerId: customer.id, audience: 'staff' },
      );
      if (!quoted.accepted) {
        throw new Error(`History order ${order.key}: ${order.template.product} can't be quoted: ${quoted.reasons.map((reason) => reason.message).join('; ')}`);
      }
      const response = await deps.orders.place(
        staff,
        customer.id,
        {
          lines: [{ quote_id: quoted.quote.id }],
          shipping_method: 'courier',
          channel_order_id: order.key,
          ...(customer.hasAddress ? {} : { address: FALLBACK_ADDRESSES.get(order.customer)! }),
        },
        'staff',
      );
      placed = { id: response.id, number: response.number, groupId: response.lines[0].group_id! };
    }
    const placedAt = at(order.day, 9 * 60 + 15 + order.slot * 9);
    const startedAt = new Date(placedAt.getTime() + 85 * MINUTE_MS);
    const { groupId } = placed;
    // Each step is done only when a crashed run hasn't done it: paying starts production, then the job is offered and accepted.
    if (!begun || begun.productionStartedAt === null) {
      await deps.paidByHand.record(staff, placed.id, { reference: `Bank transfer for order ${placed.number}`, received_on: localDate(startedAt, timezone) });
    }
    const handed = await prisma.inTenant(tenantId, (tx) => tx.jobAssignment.findFirst({ where: { groupId }, orderBy: { createdAt: 'desc' }, select: { status: true } }));
    if (!handed) await deps.jobs.offer(staff, groupId, partner.id);
    if (!handed || handed.status === 'offered') await deps.jobs.accept(partnerAuth, groupId);

    await prisma.inTenant(tenantId, async (tx) => {
      const group = await tx.workOrderGroup.findUniqueOrThrow({ where: { id: groupId }, include: { workOrders: { orderBy: { number: 'asc' } } } });
      const steps = await tx.workflowStep.findMany({ where: { versionId: group.workflowVersionId }, include: { stepType: true }, orderBy: { position: 'asc' } });
      const byId = new Map(steps.map((step) => [step.id, step]));
      const path = pathFor(stepsForPath(steps), chainOf(group)).map((id) => byId.get(id)!);
      const last = path.length - 1;
      // Spread over the first three working days after placing; a late order's last two steps wait three more.
      const plannedDay = (index: number) =>
        workingDaysAfter(order.day, (last === 0 ? 3 : 1 + Math.floor((index * 2) / last)) + (order.late && index >= last - 1 ? 3 : 0), calendar);

      // The last step on the path with a defect that sends pieces back to a step on the path, before it or to itself:
      // final QC (back to polishing or finish), or casting (porosity, back to casting) on a raw path, which has no polishing.
      let check: { index: number; defectId: string; target: number } | null = null;
      for (let index = last; index >= 0 && check === null; index--) {
        const config = path[index].config as StepConfig;
        const defect = config.defects.find((candidate) => {
          const target = candidate.rework_to ? path.findIndex((step) => step.key === candidate.rework_to) : -1;
          return candidate.outcome === 'rework' && target >= 0 && target <= index;
        });
        if (defect) check = { index, defectId: defect.defect_id, target: path.findIndex((step) => step.key === defect.rework_to) };
      }

      // One piece in eight fails the check (by its place in the plan and in the order, so a run is reproducible);
      // those pieces alone go back and pass the steps from the defect's target again. A failed piece's moves stay
      // in time order even when the target is the check step itself: the fail is on the step's day, after the
      // others' moves of that day (a later ordinal), and the redo passes start a working day after it.
      const ids = group.workOrders.map((piece) => piece.id);
      const failing = new Set(check === null ? [] : ids.filter((_, piece) => (order.index + piece) % 8 === 5));
      const passing = ids.filter((id) => !failing.has(id));
      const moves: Move[] = [];
      for (let index = 0; index <= last; index++) {
        const pieceIds = check !== null && index >= check.index ? passing : ids;
        if (pieceIds.length > 0) moves.push({ pieceIds, kind: 'pass', from: index, to: index < last ? index + 1 : null, day: plannedDay(index) });
      }
      if (check !== null && failing.size > 0) {
        const failDay = plannedDay(check.index);
        const redoDay = workingDaysAfter(failDay, 1, calendar);
        const redone = [...failing];
        moves.push({ pieceIds: redone, kind: 'fail', from: check.index, to: check.target, day: failDay });
        for (let index = check.target; index <= last; index++) {
          const planned = plannedDay(index);
          moves.push({ pieceIds: redone, kind: 'pass', from: index, to: index < last ? index + 1 : null, day: planned > redoDay ? planned : redoDay });
        }
      }

      // Each move at a time of its own on its day, in the order made, so a piece's moves never go backwards.
      await tx.transition.createMany({
        data: moves.flatMap((move, ordinal) => {
          const moveId = newId();
          const when = at(move.day, 8 * 60 + ordinal * 7);
          const step = path[move.from];
          return move.pieceIds.map((workOrderId) => ({
            id: newId(),
            moveId,
            workOrderId,
            kind: move.kind,
            outcome: move.kind === 'fail' ? 'rework' : null,
            fromStepId: step.id,
            toStepId: move.to === null ? null : path[move.to].id,
            fromStatus: 'active',
            toStatus: move.to === null ? 'finished' : 'active',
            defectId: move.kind === 'fail' ? check!.defectId : null,
            comment: move.kind === 'fail' ? 'Sent back to be redone' : null,
            actorUserId: staffUserId,
            partnerId: step.doneBy === 'partner' ? partner.id : null,
            inspected: true,
            createdAt: when,
          }));
        }),
      });
      await tx.workOrder.updateMany({ where: { groupId }, data: { status: 'finished', currentStepId: null, createdAt: placedAt } });
      // Shipped the day the last piece was done, delivered the next working day.
      const readyDay = moves.reduce((latest, move) => (move.day > latest ? move.day : latest), order.day);
      const shippedAt = at(readyDay, 15 * 60 + 30);
      const deliveredDay = workingDaysAfter(readyDay, 1, calendar);
      const promisedOn = workingDaysAfter(order.day, PROMISE_DAYS, calendar);
      // The group's promise follows the order's, as when it was placed.
      await tx.workOrderGroup.update({ where: { id: groupId }, data: { createdAt: placedAt, dueOn: asDate(promisedOn) } });

      const row = await tx.order.findUniqueOrThrow({ where: { id: placed.id } });
      const shift = row.placedAt.getTime() - placedAt.getTime();
      await tx.order.update({
        where: { id: placed.id },
        data: {
          placedAt,
          promisedOn: asDate(promisedOn),
          productionStartedAt: startedAt,
          payBy: row.payBy ? new Date(row.payBy.getTime() - shift) : null,
          shippedAt,
          courier: 'DHL',
          tracking: `JD0147${String(placed.number).padStart(8, '0')}`,
          deliveredAt: at(deliveredDay, 11 * 60),
        },
      });
      const assignment = await tx.jobAssignment.findFirstOrThrow({ where: { groupId, status: 'accepted' } });
      await tx.jobAssignment.update({
        where: { id: assignment.id },
        data: {
          createdAt: new Date(placedAt.getTime() + HOUR_MS),
          respondedAt: new Date(placedAt.getTime() + 3 * HOUR_MS),
          dueOn: asDate(workingDaysBefore(promisedOn, setup.bufferDays, calendar)),
        },
      });
      await deps.states.refresh(tx, [placed.id]);

      // Placing, paying and offering raised notifications (and queued their emails) dated today, for an order a
      // year old. Taken away with their feed rows, for this order and its jobs only: a queued dispatch finds
      // nothing to claim and does nothing. Delivery rows are never written before a dispatch, so none is left.
      const jobs = await tx.jobAssignment.findMany({ where: { groupId }, select: { id: true } });
      await tx.notification.deleteMany({ where: { subjectId: { in: [placed.id, groupId, ...jobs.map((job) => job.id)] } } });
    });
    orders++;
  }

  const { payouts, pending } = await payMonths(deps, tenantId, {
    now,
    timezone,
    currency: setup.currency,
    staffUserId,
    partnerIds: [...setup.partners.values()].map((partner) => partner.id),
  });
  return { orders, payouts, pending };
}

/**
 * Pays what each partner became owed for the history's jobs in each whole month that has ended, in one
 * payout per partner and month, dated a few days into the next month: paid, but the newest one still pending.
 * What became owed in the current month stays owed. Written directly: the payout service moves money through
 * the payment provider.
 */
async function payMonths(
  deps: HistoryDeps,
  tenantId: string,
  context: { now: Date; timezone: string; currency: string; staffUserId: string; partnerIds: string[] },
): Promise<{ payouts: number; pending: number }> {
  return deps.prisma.inTenant(tenantId, async (tx) => {
    const done = { channelOrderId: { startsWith: HISTORY_PREFIX }, deliveredAt: { not: null } };
    const first = await tx.order.findFirst({ where: done, orderBy: { placedAt: 'asc' }, select: { placedAt: true } });
    if (!first) return { payouts: 0, pending: 0 };
    // The history's own jobs, whenever they were made: a run that finds them paid already pays nothing.
    const lines = await tx.orderLine.findMany({ where: { order: done, groupId: { not: null } }, select: { groupId: true } });
    const jobs = await tx.jobAssignment.findMany({ where: { groupId: { in: lines.map((line) => line.groupId!) }, status: 'accepted' }, select: { id: true } });
    const assignmentIds = new Set(jobs.map((job) => job.id));
    const firstDay = localDate(first.placedAt, context.timezone);
    let month = `${firstDay.slice(0, 7)}-01`;
    let payouts = 0;
    for (;;) {
      const next = nextMonthStart(month);
      const paidAt = new Date(startOfLocalDay(next, context.timezone).getTime() + (4 * 24 + 10) * HOUR_MS);
      if (paidAt > context.now) break;
      const from = startOfLocalDay(month, context.timezone);
      const to = startOfLocalDay(next, context.timezone);
      for (const partnerId of context.partnerIds) {
        // What no payout, paid or on its way, holds yet.
        const due = (entry: OwedEntry) => entry.amount.sub(entry.paid).sub(entry.pending);
        const owed = (await owedBetween(tx, from, to, partnerId)).filter((entry) => assignmentIds.has(entry.assignmentId) && due(entry).gt(0));
        const total = owed.reduce((sum, entry) => sum.add(due(entry)), new Prisma.Decimal(0));
        if (!total.gt(0)) continue;
        await tx.payout.create({
          data: {
            partnerId,
            amount: total,
            currency: context.currency,
            status: 'paid',
            providerTransferId: `tr_history_${newId()}`,
            createdByUserId: context.staffUserId,
            createdAt: paidAt,
            settledAt: new Date(paidAt.getTime() + HOUR_MS),
            jobs: { create: owed.map((entry) => ({ assignmentId: entry.assignmentId, amount: due(entry) })) },
          },
        });
        payouts++;
      }
      month = next;
    }
    return { payouts, pending: await keepNewestPending(tx, assignmentIds) };
  });
}

/**
 * Leaves exactly one of the history's payouts pending, the newest, so the partner dashboard shows money on its
 * way; one an earlier run left pending is settled as paid. Returns how many are pending now: 1, or 0 without payouts.
 */
async function keepNewestPending(tx: Prisma.TransactionClient, assignmentIds: Set<string>): Promise<number> {
  const history = await tx.payout.findMany({
    where: { jobs: { some: { assignmentId: { in: [...assignmentIds] } } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true, createdAt: true },
  });
  if (history.length === 0) return 0;
  const [newest, ...older] = history;
  for (const payout of older.filter((row) => row.status === 'pending')) {
    await tx.payout.update({
      where: { id: payout.id },
      data: { status: 'paid', providerTransferId: `tr_history_${newId()}`, settledAt: new Date(payout.createdAt.getTime() + HOUR_MS) },
    });
  }
  if (newest.status !== 'pending') {
    await tx.payout.update({ where: { id: newest.id }, data: { status: 'pending', providerTransferId: null, settledAt: null } });
  }
  return 1;
}
