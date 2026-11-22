import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { TenantAuth } from '../identity/auth-context';
import { localDate, startOfLocalDay } from '../orders/dates';
import { EligibilityService } from '../partners/eligibility.service';
import { owedBetween } from '../partners/owed-dates';
import { SettingsService } from '../settings/settings.service';
import type { SettingValue } from '../settings/setting-keys';
import type { DashboardResponse } from './dashboard-response';
import { spanDays } from './exports/export-kinds';
import { bucketsFor, foldDays, pickBucket, previousRange, shiftBack } from './range-buckets';
import type { RangeQuery } from './range-buckets';
import { forRangeReader, rangeMetricsSchema, revenueByGroup, revenueByProduct } from './range-metrics';
import type { RangeMetrics } from './range-metrics';
import { productionNow } from './production-now';
import type { WipRow } from './production-now';
import type { RangeResponse } from './range-response';
import { PIECES_WITH_FINISH, addTotals, dailyTotals, emptyTotals, pointOf, readyOn } from './series';
import { addDays, emptyWeek, forReader, medianHours, onTimeRate, orderingLess, weekMetricsSchema, weekOf } from './week-metrics';
import type { WeekMetrics } from './week-metrics';

type Tx = Prisma.TransactionClient;

/** The dates being computed (a week, or any range), the instants they span, and the day they are judged at. */
interface Span {
  /** The first date. */
  start: string;
  /** The date after the last. */
  until: string;
  from: Date;
  to: Date;
  /** Today while the span is still running; its last date once it has ended. */
  asOf: string;
  timeZone: string;
}

const HOUR_MS = 3_600_000;
const zero = () => new Prisma.Decimal(0);

/** A UTC midnight for a `@db.Date` column. */
const dateOnly = (date: string) => new Date(`${date}T00:00:00Z`);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);

/** Each partner's fullest step type now: what its open jobs hold, of one period's capacity, fullest first. */
export async function partnerLoads(tx: Tx, eligibility: EligibilityService): Promise<WeekMetrics['partners']['load']> {
  const partners = await tx.partner.findMany({
    where: { capabilities: { some: {} } },
    select: { id: true, name: true, capabilities: { select: { stepTypeId: true, capacity: true } } },
  });
  if (partners.length === 0) return [];
  const loads = await eligibility.loads(tx, partners.map((partner) => partner.id));
  return partners
    .map((partner) => ({
      id: partner.id,
      name: partner.name,
      percent: Math.max(
        0,
        ...partner.capabilities
          .filter((capability) => capability.capacity > 0)
          .map((capability) => Math.round(((loads.get(partner.id)?.get(capability.stepTypeId) ?? 0) * 100) / capability.capacity)),
      ),
    }))
    .sort((a, b) => b.percent - a.percent);
}

/**
 * Per partner, the share of its accepted jobs due from `from` until before `until` (calendar dates) that
 * were done by their due date, judged at `today`; worst first. Partners with none due are left out.
 */
export async function partnerOnTimeBetween(
  tx: Tx,
  dates: { from: string; until: string },
  today: string,
  timeZone: string,
): Promise<WeekMetrics['partners']['on_time']> {
  const jobs = await tx.jobAssignment.findMany({
    where: { status: 'accepted', dueOn: { gte: dateOnly(dates.from), lt: dateOnly(dates.until) } },
    select: {
      dueOn: true,
      partner: { select: { id: true, name: true } },
      group: { select: { workOrders: PIECES_WITH_FINISH } },
    },
  });
  const by = new Map<string, { id: string; name: string; lines: { promisedOn: string; readyOn: string | null }[] }>();
  for (const job of jobs) {
    const entry = by.get(job.partner.id) ?? { id: job.partner.id, name: job.partner.name, lines: [] };
    entry.lines.push({ promisedOn: dayOf(job.dueOn!), readyOn: readyOn(job.group.workOrders, timeZone) });
    by.set(job.partner.id, entry);
  }
  return [...by.values()]
    .map((entry) => ({ id: entry.id, name: entry.name, rate: onTimeRate(entry.lines, today) }))
    .filter((entry): entry is { id: string; name: string; rate: number } => entry.rate !== null)
    .sort((a, b) => a.rate - b.rate);
}

/**
 * The dashboard's numbers (AI 1 spec, goals 4 and 5): this week and last, computed by `reports.refresh`
 * into `report_week` and read by staff with `report.read`. Reads other modules' tables, never writes them.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
    private readonly settings: SettingsService,
  ) {}

  /** Every active workspace; one failing doesn't cost the others their numbers. */
  async refreshEverywhere(at: Date): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const tenant of tenants) {
      try {
        await this.refresh(tenant.id, at);
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'refreshing the dashboard numbers failed for a workspace');
      }
    }
  }

  /** Recomputes the week holding `at` and the one before, in the workspace's time zone. */
  async refresh(tenantId: string, at: Date): Promise<void> {
    await this.prisma.inTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, defaultCurrency: true } });
      const { start, previousStart } = weekOf(at, tenant.timezone);
      const today = localDate(at, tenant.timezone);
      for (const weekStart of [start, previousStart]) {
        const span: Span = {
          start: weekStart,
          until: addDays(weekStart, 7),
          from: startOfLocalDay(weekStart, tenant.timezone),
          to: startOfLocalDay(addDays(weekStart, 7), tenant.timezone),
          asOf: weekStart === start ? today : addDays(weekStart, 6),
          timeZone: tenant.timezone,
        };
        const data = weekMetricsSchema.parse(await this.compute(tx, span, tenant.defaultCurrency, today, weekStart === start));
        await tx.reportWeek.upsert({
          where: { tenantId_weekStart: { tenantId, weekStart: dateOnly(weekStart) } },
          create: { weekStart: dateOnly(weekStart), data, computedAt: at },
          update: { data, computedAt: at },
        });
      }
    });
  }

  /**
   * The dashboard's numbers for any dates in the workspace's time zone, both ends included, plus revenue
   * per product (Reporting 2 spec, goals 14–15), worked out from the records like a stored week. While
   * the range is still running it is judged at today, with live partner load; once ended, at its last day,
   * with the snapshots' load. Not shaped for a reader: the caller applies `forRangeReader`.
   */
  async metricsFor(tenantId: string, range: { from: string; to: string }, at: Date = new Date()): Promise<RangeMetrics> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, defaultCurrency: true } });
      const today = localDate(at, tenant.timezone);
      const until = addDays(range.to, 1);
      const running = range.to >= today;
      const span: Span = {
        start: range.from,
        until,
        from: startOfLocalDay(range.from, tenant.timezone),
        to: startOfLocalDay(until, tenant.timezone),
        asOf: running ? today : range.to,
        timeZone: tenant.timezone,
      };
      const week = weekMetricsSchema.parse(await this.compute(tx, span, tenant.defaultCurrency, today, running));
      const lines = await tx.orderLine.findMany({
        where: { cancelledAt: null, order: { cancelledAt: null, placedAt: { gte: span.from, lt: span.to } } },
        select: { productId: true, quantity: true, total: true, product: { select: { name: true } }, order: { select: { currency: true } } },
      });
      const byProduct = revenueByProduct(
        lines.map((line) => ({ productId: line.productId, name: line.product.name, quantity: line.quantity, total: line.total, currency: line.order.currency })),
        tenant.defaultCurrency,
      );
      const orders = await tx.order.findMany({
        where: { cancelledAt: null, placedAt: { gte: span.from, lt: span.to } },
        select: { customerGroupId: true, total: true, taxAmount: true, currency: true, customerGroup: { select: { id: true, key: true, name: true } } },
      });
      const groups = new Map(orders.flatMap((order) => (order.customerGroup ? [[order.customerGroup.id, order.customerGroup] as const] : [])));
      const byGroup = revenueByGroup(
        orders.map((order) => ({ groupId: order.customerGroupId, net: order.total.sub(order.taxAmount), currency: order.currency })),
        groups,
        tenant.defaultCurrency,
      );
      const owed = await owedBetween(tx, span.from, span.to);
      const cost = owed.reduce((sum, entry) => sum.add(entry.amount), zero());
      return rangeMetricsSchema.parse({
        ...week,
        orders: { ...week.orders, by_product: byProduct, by_customer_group: byGroup },
        production: { ...week.production, defects_by_kind: await this.defectsByKind(tx, span) },
        partners: { ...week.partners, cost: { amount: cost.toFixed(2), currency: tenant.defaultCurrency } },
      });
    });
  }

  /**
   * The dashboard's numbers for `query` and the period before it, with a point per bucket (dashboard data
   * spec, "Range response"), shaped for the reader. Each daily measure is loaded once over both periods;
   * a point's `previous` is its own days one range earlier.
   */
  async range(auth: TenantAuth, query: RangeQuery, at: Date = new Date()): Promise<RangeResponse> {
    const dates = { from: query.from, to: query.to };
    const before = previousRange(dates);
    const bucket = pickBucket(dates, query.bucket);
    const current = await this.metricsFor(auth.tenantId, dates, at);
    const previous = await this.metricsFor(auth.tenantId, before, at);
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { timezone: true, defaultCurrency: true } });
      const days = await dailyTotals(tx, {
        from: before.from,
        to: dates.to,
        timeZone: tenant.timezone,
        currency: tenant.defaultCurrency,
        today: localDate(at, tenant.timezone),
      });
      const spans = bucketsFor(dates, bucket);
      const length = spanDays(dates);
      const totals = foldDays(spans, days, emptyTotals, addTotals);
      const earlier = foldDays(spans.map((span) => shiftBack(span, length)), days, emptyTotals, addTotals);
      const may = { money: auth.permissions.has('payment.read'), partners: auth.permissions.has('partner.read') };
      const targets = (await this.settings.list(tx))['reports.targets'] as SettingValue<'reports.targets'> | undefined;
      return {
        range: { from: dates.from, to: dates.to, previous_from: before.from, previous_to: before.to, bucket },
        current: forRangeReader(current, may),
        previous: forRangeReader(previous, may),
        series: spans.map((span, index) => ({
          start: span.start,
          days: span.days,
          ...pointOf(totals[index], may),
          previous: pointOf(earlier[index], may),
        })),
        on_time_target: targets?.onTimeRate ?? null,
        computed_at: at.toISOString(),
      };
    });
  }

  /** Inspected fails recording a defect in the span, per defect: most first, then by name. */
  private async defectsByKind(tx: Tx, span: Span): Promise<RangeMetrics['production']['defects_by_kind']> {
    const counted = await tx.transition.groupBy({
      by: ['defectId'],
      where: { kind: 'fail', inspected: true, defectId: { not: null }, createdAt: { gte: span.from, lt: span.to } },
      _count: { _all: true },
    });
    const ids = counted.flatMap((row) => (row.defectId === null ? [] : [row.defectId]));
    if (ids.length === 0) return [];
    const defects = new Map(
      (await tx.defect.findMany({ where: { id: { in: ids } }, select: { id: true, key: true, name: true } })).map((defect) => [defect.id, defect]),
    );
    return counted
      .flatMap((row) => {
        const defect = row.defectId === null ? undefined : defects.get(row.defectId);
        return defect ? [{ defect_id: defect.id, key: defect.key, name: defect.name, count: row._count._all }] : [];
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  /** The pieces in production now per step type, as of today in the workspace's time zone. */
  async productionWip(auth: TenantAuth, now: Date): Promise<WipRow[]> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { timezone: true } });
      return productionNow(tx, localDate(now, tenant.timezone));
    });
  }

  /** This week and last as the reader may see them; empty weeks before the first refresh. */
  async dashboardNumbers(auth: TenantAuth): Promise<Omit<DashboardResponse, 'attention'>> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { timezone: true, defaultCurrency: true } });
      const { start, previousStart } = weekOf(new Date(), tenant.timezone);
      const rows = await tx.reportWeek.findMany({ where: { weekStart: { in: [dateOnly(start), dateOnly(previousStart)] } } });
      const may = { money: auth.permissions.has('payment.read'), partners: auth.permissions.has('partner.read') };
      const week = (date: string) => {
        const row = rows.find((one) => dayOf(one.weekStart) === date);
        return forReader(row ? weekMetricsSchema.parse(row.data) : emptyWeek(tenant.defaultCurrency), may);
      };
      const current = rows.find((one) => dayOf(one.weekStart) === start);
      return {
        week: { start, previous_start: previousStart, computed_at: current?.computedAt.toISOString() ?? null },
        current: week(start),
        previous: week(previousStart),
      };
    });
  }

  /** The numbers of `span`; `live` takes partner load as it is now, else from the snapshots of its days. */
  private async compute(tx: Tx, span: Span, currency: string, today: string, live: boolean): Promise<WeekMetrics> {
    const placed = await tx.order.findMany({
      where: { placedAt: { gte: span.from, lt: span.to }, cancelledAt: null },
      select: { customerId: true, total: true, taxAmount: true, currency: true },
    });
    const revenueBy = new Map<string, Prisma.Decimal>();
    let revenue = zero();
    let priced = 0;
    for (const order of placed.filter((one) => one.currency === currency)) {
      const net = order.total.sub(order.taxAmount);
      revenue = revenue.add(net);
      priced += 1;
      revenueBy.set(order.customerId, (revenueBy.get(order.customerId) ?? zero()).add(net));
    }

    const topIds = [...revenueBy].sort((a, b) => b[1].cmp(a[1])).slice(0, 5);
    const slow = await this.slowPayers(tx, span, currency);
    const silent = await this.orderingLess(tx, span);
    const names = await this.customerNames(tx, [...topIds.map(([id]) => id), ...slow.map((one) => one.id), ...silent.map((one) => one.id)]);

    return {
      currency,
      orders: {
        placed: placed.length,
        revenue: revenue.toFixed(2),
        average_value: priced === 0 ? null : revenue.div(priced).toFixed(2),
      },
      production: {
        on_time_rate: await this.onTime(tx, span, today),
        step_hours: await this.stepHours(tx, span),
        defect_rate: await this.defectRate(tx, span),
        claims: await tx.claim.count({ where: { createdAt: { gte: span.from, lt: span.to } } }),
        remakes: await tx.claimLine.count({ where: { outcome: 'remake', decidedAt: { gte: span.from, lt: span.to } } }),
      },
      customers: {
        new: await tx.customer.count({ where: { createdAt: { gte: span.from, lt: span.to } } }),
        top: topIds.map(([id, amount]) => ({ id, name: names.get(id) ?? '', revenue: amount.toFixed(2) })),
        ordering_less: silent,
        slow_payers: slow.map((one) => ({ id: one.id, name: names.get(one.id) ?? '', overdue: one.overdue.toFixed(2) })),
      },
      partners: {
        load: live ? await this.liveLoad(tx) : await this.snapshotLoad(tx, span),
        on_time: await this.partnerOnTime(tx, span, today),
      },
    };
  }

  private async customerNames(tx: Tx, ids: string[]): Promise<Map<string, string>> {
    const rows = await tx.customer.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /** The day a group's last live piece finished, when every live piece has. */
  /** Lines whose order is promised within the span, ready by that date. */
  private async onTime(tx: Tx, span: Span, today: string): Promise<number | null> {
    const lines = await tx.orderLine.findMany({
      where: { cancelledAt: null, order: { cancelledAt: null, promisedOn: { gte: dateOnly(span.start), lt: dateOnly(span.until) } } },
      select: { order: { select: { promisedOn: true } }, group: { select: { workOrders: PIECES_WITH_FINISH } } },
    });
    return onTimeRate(
      lines.map((line) => ({
        promisedOn: dayOf(line.order.promisedOn),
        readyOn: line.group ? readyOn(line.group.workOrders, span.timeZone) : null,
      })),
      today,
    );
  }

  /** The median hours a piece spent at each step type, for the moves out of a step made in the week. */
  private async stepHours(tx: Tx, span: Span): Promise<WeekMetrics['production']['step_hours']> {
    const moved = await tx.transition.findMany({
      where: { createdAt: { gte: span.from, lt: span.to }, fromStepId: { not: null } },
      select: { workOrderId: true },
      distinct: ['workOrderId'],
    });
    const ids = moved.map((row) => row.workOrderId);
    if (ids.length === 0) return [];
    const pieces = await tx.workOrder.findMany({
      where: { id: { in: ids } },
      select: {
        createdAt: true,
        transitions: {
          where: { createdAt: { lt: span.to } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { createdAt: true, fromStep: { select: { stepTypeId: true, stepType: { select: { name: true } } } } },
        },
      },
    });
    const byType = new Map<string, { name: string; hours: number[] }>();
    for (const piece of pieces) {
      let since = piece.createdAt;
      for (const move of piece.transitions) {
        if (move.fromStep && move.createdAt >= span.from) {
          const entry = byType.get(move.fromStep.stepTypeId) ?? { name: move.fromStep.stepType.name, hours: [] };
          entry.hours.push((move.createdAt.getTime() - since.getTime()) / HOUR_MS);
          byType.set(move.fromStep.stepTypeId, entry);
        }
        since = move.createdAt;
      }
    }
    return [...byType]
      .map(([stepTypeId, entry]) => ({
        step_type_id: stepTypeId,
        name: entry.name,
        median_hours: Math.round(medianHours(entry.hours)! * 100) / 100,
      }))
      .sort((a, b) => b.median_hours - a.median_hours);
  }

  /**
   * QC moves (every inspected pass or fail) recording a defect, of all QC moves in the week. A pass left
   * out of a sample never had a chance to find a defect (Workflow 2 spec).
   */
  private async defectRate(tx: Tx, span: Span): Promise<number | null> {
    const where = { createdAt: { gte: span.from, lt: span.to }, kind: { in: ['pass', 'fail'] }, inspected: true };
    const moves = await tx.transition.count({ where });
    if (moves === 0) return null;
    return (await tx.transition.count({ where: { ...where, defectId: { not: null } } })) / moves;
  }

  /** Customers with invoices past due at the week's end, most overdue first. */
  private async slowPayers(tx: Tx, span: Span, currency: string): Promise<{ id: string; overdue: Prisma.Decimal }[]> {
    const invoices = await tx.invoice.findMany({
      where: {
        currency,
        dueOn: { lt: dateOnly(span.asOf) },
        OR: [{ status: 'open' }, { status: 'paid', paidAt: { gte: span.to } }],
      },
      select: { total: true, order: { select: { customerId: true } } },
    });
    const by = new Map<string, Prisma.Decimal>();
    for (const invoice of invoices) {
      by.set(invoice.order.customerId, (by.get(invoice.order.customerId) ?? zero()).add(invoice.total));
    }
    return [...by]
      .sort((a, b) => b[1].cmp(a[1]))
      .slice(0, 20)
      .map(([id, overdue]) => ({ id, overdue }));
  }

  private async orderingLess(tx: Tx, span: Span) {
    const orders = await tx.order.findMany({
      where: { placedAt: { lt: span.to }, cancelledAt: null },
      select: { customerId: true, placedAt: true, customer: { select: { name: true } } },
    });
    const by = new Map<string, { id: string; name: string; orderDates: string[] }>();
    for (const order of orders) {
      const entry = by.get(order.customerId) ?? { id: order.customerId, name: order.customer.name, orderDates: [] };
      entry.orderDates.push(localDate(order.placedAt, span.timeZone));
      by.set(order.customerId, entry);
    }
    return orderingLess([...by.values()], span.asOf);
  }

  private liveLoad(tx: Tx): Promise<WeekMetrics['partners']['load']> {
    return partnerLoads(tx, this.eligibility);
  }

  /** An ended span's fullest day per partner, from the daily capacity snapshots (D83). */
  private async snapshotLoad(tx: Tx, span: Span): Promise<WeekMetrics['partners']['load']> {
    const rows = await tx.partnerCapacitySnapshot.findMany({
      where: { date: { gte: dateOnly(span.start), lt: dateOnly(span.until) }, capacity: { gt: 0 } },
      select: { load: true, capacity: true, partner: { select: { id: true, name: true } } },
    });
    const by = new Map<string, { id: string; name: string; percent: number }>();
    for (const row of rows) {
      const percent = Math.round((row.load * 100) / row.capacity);
      const entry = by.get(row.partner.id);
      if (!entry || entry.percent < percent) by.set(row.partner.id, { id: row.partner.id, name: row.partner.name, percent });
    }
    return [...by.values()].sort((a, b) => b.percent - a.percent);
  }

  /** Per partner, the share of its accepted jobs due within the span that were done by their due date. */
  private partnerOnTime(tx: Tx, span: Span, today: string): Promise<WeekMetrics['partners']['on_time']> {
    return partnerOnTimeBetween(tx, { from: span.start, until: span.until }, today, span.timeZone);
  }
}
