import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { RecordRef } from '../ai/tools/tool';
import type { TenantAuth } from '../identity/auth-context';
import type { TenantPermission } from '../identity/permissions';
import { localDate, startOfLocalDay, workingDaysAfter } from '../orders/dates';
import type { BusinessCalendar } from '../orders/dates';
import { lineState, orderState } from '../orders/order-state';
import { DEFAULT_CALENDAR } from '../orders/place-order';
import { EligibilityService } from '../partners/eligibility.service';
import { SettingsService } from '../settings/settings.service';
import { partnerLoads } from './reports.service';
import { addDays, weekOf } from './week-metrics';

type Tx = Prisma.TransactionClient;

/** What needs attention now (AI 1 spec, goal 6), in the order the dashboard shows it. */
export const ATTENTION_KINDS = [
  'order_at_risk',
  'job_overdue',
  'awaiting_payment',
  'credit_hold',
  'invoice_overdue',
  'subscription_past_due',
  'partner_near_capacity',
  'offer_unanswered',
  'defect_spike',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** Each kind follows the permission of the list it comes from. */
const PERMISSION: Record<AttentionKind, TenantPermission> = {
  order_at_risk: 'order.read',
  job_overdue: 'order.read',
  awaiting_payment: 'payment.read',
  credit_hold: 'payment.read',
  invoice_overdue: 'payment.read',
  subscription_past_due: 'payment.read',
  partner_near_capacity: 'partner.read',
  offer_unanswered: 'partner.read',
  defect_spike: 'workflow.read',
};

export const MAX_ITEMS = 20;
/** Working days before the promised date at which an order counts as at risk (Settled after the builder check). */
const AT_RISK_WORKING_DAYS = 2;
const NEAR_CAPACITY_PERCENT = 90;
const UNANSWERED_MS = 24 * 3_600_000;
const SPIKE_MIN_DEFECTS = 3;

export interface AttentionItem {
  ref: RecordRef;
  label: string;
  /** Since when it needs attention: a date or an instant, where one applies. */
  since: string | null;
}
export interface AttentionGroup {
  kind: AttentionKind;
  total: number;
  items: AttentionItem[];
}

interface Context {
  now: Date;
  today: string;
  timeZone: string;
}

const dateOnly = (date: string) => new Date(`${date}T00:00:00Z`);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const listed = (items: AttentionItem[]) => ({ total: items.length, items: items.slice(0, MAX_ITEMS) });

/** Live rules over the workspace's data: no AI, no cost, read whenever the dashboard is. */
@Injectable()
export class AttentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
    private readonly settings: SettingsService,
  ) {}

  /** Every kind the reader may see, each with its total and at most 20 items. */
  async list(auth: TenantAuth, at: Date): Promise<AttentionGroup[]> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { timezone: true } });
      const context: Context = { now: at, today: localDate(at, timezone), timeZone: timezone };
      const groups: AttentionGroup[] = [];
      for (const kind of ATTENTION_KINDS.filter((one) => auth.permissions.has(PERMISSION[one]))) {
        groups.push({ kind, ...(await this.kind(tx, kind, context)) });
      }
      return groups;
    });
  }

  private kind(tx: Tx, kind: AttentionKind, context: Context): Promise<{ total: number; items: AttentionItem[] }> {
    switch (kind) {
      case 'order_at_risk':
        return this.ordersAtRisk(tx, context);
      case 'job_overdue':
        return this.jobsOverdue(tx, context);
      case 'awaiting_payment':
        return this.waiting(tx, false);
      case 'credit_hold':
        return this.waiting(tx, true);
      case 'invoice_overdue':
        return this.invoicesOverdue(tx, context);
      case 'subscription_past_due':
        return this.subscriptionsPastDue(tx);
      case 'partner_near_capacity':
        return this.partnersNearCapacity(tx);
      case 'offer_unanswered':
        return this.offersUnanswered(tx, context);
      case 'defect_spike':
        return this.defectSpike(tx, context);
    }
  }

  /** Promised date passed or within 2 working days, and not ready, shipped, delivered or cancelled. */
  private async ordersAtRisk(tx: Tx, context: Context) {
    const calendar = ((await this.settings.list(tx))['business.calendar'] as BusinessCalendar | undefined) ?? DEFAULT_CALENDAR;
    const orders = await tx.order.findMany({
      where: {
        cancelledAt: null,
        shippedAt: null,
        deliveredAt: null,
        promisedOn: { lte: dateOnly(workingDaysAfter(context.today, AT_RISK_WORKING_DAYS, calendar)) },
      },
      orderBy: [{ promisedOn: 'asc' }, { number: 'asc' }],
      select: {
        id: true,
        number: true,
        promisedOn: true,
        productionStartedAt: true,
        customer: { select: { name: true } },
        lines: { select: { cancelledAt: true, group: { select: { workOrders: { select: { status: true } } } } } },
      },
    });
    const risky = orders.filter((order) => {
      const lines = order.lines.map((line) => lineState(line.group?.workOrders ?? [], line.cancelledAt));
      return !['ready', 'cancelled'].includes(orderState(lines, null, null, order.productionStartedAt));
    });
    return listed(
      risky.map((order) => ({
        ref: { type: 'order' as const, id: order.id },
        label: `Order ${order.number} for ${order.customer.name}, promised ${dayOf(order.promisedOn)}`,
        since: dayOf(order.promisedOn),
      })),
    );
  }

  /** Accepted jobs past their due date with pieces still to make. */
  private async jobsOverdue(tx: Tx, context: Context) {
    const where: Prisma.JobAssignmentWhereInput = {
      status: 'accepted',
      dueOn: { lt: dateOnly(context.today) },
      group: { workOrders: { some: { status: 'active' } } },
    };
    const [total, jobs] = await Promise.all([
      tx.jobAssignment.count({ where }),
      tx.jobAssignment.findMany({
        where,
        orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
        take: MAX_ITEMS,
        select: { id: true, dueOn: true, partner: { select: { name: true } } },
      }),
    ]);
    return {
      total,
      items: jobs.map((job) => ({
        ref: { type: 'job' as const, id: job.id },
        label: `Job at ${job.partner.name}, due ${dayOf(job.dueOn!)}`,
        since: dayOf(job.dueOn!),
      })),
    };
  }

  /** Orders not started because they wait for payment, or are held over the customer's credit limit. */
  private async waiting(tx: Tx, heldForCredit: boolean) {
    const where: Prisma.OrderWhereInput = { cancelledAt: null, productionStartedAt: null, heldForCredit };
    const [total, orders] = await Promise.all([
      tx.order.count({ where }),
      tx.order.findMany({
        where,
        orderBy: [{ placedAt: 'asc' }, { id: 'asc' }],
        take: MAX_ITEMS,
        select: { id: true, number: true, placedAt: true, customer: { select: { name: true } } },
      }),
    ]);
    return {
      total,
      items: orders.map((order) => ({
        ref: { type: 'order' as const, id: order.id },
        label: `Order ${order.number} for ${order.customer.name}, ${heldForCredit ? 'held over its credit limit' : 'waiting for payment'}`,
        since: order.placedAt.toISOString(),
      })),
    };
  }

  private async invoicesOverdue(tx: Tx, context: Context) {
    const where: Prisma.InvoiceWhereInput = { status: 'open', dueOn: { lt: dateOnly(context.today) } };
    const [total, invoices] = await Promise.all([
      tx.invoice.count({ where }),
      tx.invoice.findMany({
        where,
        orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
        take: MAX_ITEMS,
        select: { id: true, total: true, currency: true, dueOn: true, order: { select: { number: true, customer: { select: { name: true } } } } },
      }),
    ]);
    return {
      total,
      items: invoices.map((invoice) => ({
        ref: { type: 'invoice' as const, id: invoice.id },
        label: `${invoice.order.customer.name}: ${invoice.total.toFixed(2)} ${invoice.currency} for order ${invoice.order.number}, due ${dayOf(invoice.dueOn)}`,
        since: dayOf(invoice.dueOn),
      })),
    };
  }

  private async subscriptionsPastDue(tx: Tx) {
    const where: Prisma.CustomerSubscriptionWhereInput = { status: 'past_due' };
    const [total, subscriptions] = await Promise.all([
      tx.customerSubscription.count({ where }),
      tx.customerSubscription.findMany({
        where,
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: MAX_ITEMS,
        select: { customerId: true, updatedAt: true, customer: { select: { name: true } } },
      }),
    ]);
    return {
      total,
      items: subscriptions.map((subscription) => ({
        ref: { type: 'customer' as const, id: subscription.customerId },
        label: `${subscription.customer.name}: plan payment failed`,
        since: subscription.updatedAt.toISOString(),
      })),
    };
  }

  /** Partners whose fullest step type is at 90 % of its capacity or more. */
  private async partnersNearCapacity(tx: Tx) {
    const full = (await partnerLoads(tx, this.eligibility)).filter((partner) => partner.percent >= NEAR_CAPACITY_PERCENT);
    return listed(
      full.map((partner) => ({
        ref: { type: 'partner' as const, id: partner.id },
        label: `${partner.name}: ${partner.percent} % of capacity`,
        since: null,
      })),
    );
  }

  /** Offers still open after more than a day. */
  private async offersUnanswered(tx: Tx, context: Context) {
    const where: Prisma.JobAssignmentWhereInput = {
      status: 'offered',
      expiresAt: { gt: context.now },
      createdAt: { lt: new Date(context.now.getTime() - UNANSWERED_MS) },
    };
    const [total, offers] = await Promise.all([
      tx.jobAssignment.count({ where }),
      tx.jobAssignment.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: MAX_ITEMS,
        select: { id: true, createdAt: true, partner: { select: { name: true } } },
      }),
    ]);
    return {
      total,
      items: offers.map((offer) => ({
        ref: { type: 'job' as const, id: offer.id },
        label: `Offer to ${offer.partner.name}, unanswered for ${Math.floor((context.now.getTime() - offer.createdAt.getTime()) / 3_600_000)} hours`,
        since: offer.createdAt.toISOString(),
      })),
    };
  }

  /**
   * This week's defect rate more than double last week's, with at least 3 defects: one item per step
   * type that recorded defects this week, most first.
   */
  private async defectSpike(tx: Tx, context: Context) {
    const { start, previousStart } = weekOf(context.now, context.timeZone);
    const span = (from: string) => ({ gte: startOfLocalDay(from, context.timeZone), lt: startOfLocalDay(addDays(from, 7), context.timeZone) });
    const rate = async (from: string) => {
      const moves = await tx.transition.count({ where: { createdAt: span(from), kind: { in: ['pass', 'fail'] } } });
      const defects = await tx.transition.count({ where: { createdAt: span(from), kind: { in: ['pass', 'fail'] }, defectId: { not: null } } });
      return { defects, rate: moves === 0 ? 0 : defects / moves };
    };
    const now = await rate(start);
    const before = await rate(previousStart);
    if (now.defects < SPIKE_MIN_DEFECTS || now.rate <= 2 * before.rate) return { total: 0, items: [] };

    const defects = await tx.transition.findMany({
      where: { createdAt: span(start), kind: { in: ['pass', 'fail'] }, defectId: { not: null }, fromStepId: { not: null } },
      select: { fromStep: { select: { stepTypeId: true, stepType: { select: { name: true } } } } },
    });
    const by = new Map<string, { name: string; count: number }>();
    for (const move of defects) {
      const entry = by.get(move.fromStep!.stepTypeId) ?? { name: move.fromStep!.stepType.name, count: 0 };
      entry.count += 1;
      by.set(move.fromStep!.stepTypeId, entry);
    }
    const percent = (value: number) => Math.round(value * 100);
    return listed(
      [...by]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([stepTypeId, entry]) => ({
          ref: { type: 'step' as const, id: stepTypeId },
          label: `${entry.name}: ${entry.count} defects this week (${percent(now.rate)} % of moves, ${percent(before.rate)} % last week)`,
          since: start,
        })),
    );
  }
}
