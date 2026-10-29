import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { TenantAuth } from '../identity/auth-context';
import { localDate, startOfLocalDay } from '../orders/dates';
import { EligibilityService } from '../partners/eligibility.service';
import { groupReady } from '../workflow/progress';
import type { DashboardResponse } from './dashboard-response';
import { addDays, emptyWeek, forReader, medianHours, onTimeRate, orderingLess, weekMetricsSchema, weekOf } from './week-metrics';
import type { WeekMetrics } from './week-metrics';

type Tx = Prisma.TransactionClient;

/** One week being computed: its Monday, the instants it spans, and the day it is judged at. */
interface Span {
  start: string;
  from: Date;
  to: Date;
  /** Today for the current week; the week's Sunday for an earlier one. */
  asOf: string;
  timeZone: string;
}

/** A group's pieces, each with when it finished, if it has. */
const PIECES_WITH_FINISH = {
  select: {
    status: true,
    transitions: { where: { toStatus: 'finished' }, select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
  },
} as const;

const HOUR_MS = 3_600_000;
const zero = () => new Prisma.Decimal(0);

/** A UTC midnight for a `@db.Date` column. */
const dateOnly = (date: string) => new Date(`${date}T00:00:00Z`);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);

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

  /** This week and last as the reader may see them; empty weeks before the first refresh. */
  async dashboardNumbers(auth: TenantAuth): Promise<DashboardResponse> {
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

  private async compute(tx: Tx, span: Span, currency: string, today: string, isCurrent: boolean): Promise<WeekMetrics> {
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
      },
      customers: {
        new: await tx.customer.count({ where: { createdAt: { gte: span.from, lt: span.to } } }),
        top: topIds.map(([id, amount]) => ({ id, name: names.get(id) ?? '', revenue: amount.toFixed(2) })),
        ordering_less: silent,
        slow_payers: slow.map((one) => ({ id: one.id, name: names.get(one.id) ?? '', overdue: one.overdue.toFixed(2) })),
      },
      partners: {
        load: isCurrent ? await this.liveLoad(tx) : await this.snapshotLoad(tx, span),
        on_time: await this.partnerOnTime(tx, span, today),
      },
    };
  }

  private async customerNames(tx: Tx, ids: string[]): Promise<Map<string, string>> {
    const rows = await tx.customer.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /** The day a group's last live piece finished, when every live piece has. */
  private readyOn(pieces: { status: string; transitions: { createdAt: Date }[] }[], timeZone: string): string | null {
    if (!groupReady(pieces)) return null;
    const finished = pieces.flatMap((piece) => piece.transitions.map((move) => move.createdAt.getTime()));
    if (finished.length === 0) return null;
    return localDate(new Date(Math.max(...finished)), timeZone);
  }

  /** Lines whose order is promised within the week, ready by that date. */
  private async onTime(tx: Tx, span: Span, today: string): Promise<number | null> {
    const lines = await tx.orderLine.findMany({
      where: { cancelledAt: null, order: { cancelledAt: null, promisedOn: { gte: dateOnly(span.start), lt: dateOnly(addDays(span.start, 7)) } } },
      select: { order: { select: { promisedOn: true } }, group: { select: { workOrders: PIECES_WITH_FINISH } } },
    });
    return onTimeRate(
      lines.map((line) => ({
        promisedOn: dayOf(line.order.promisedOn),
        readyOn: line.group ? this.readyOn(line.group.workOrders, span.timeZone) : null,
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

  /** QC moves (every pass or fail) recording a defect, of all QC moves in the week. */
  private async defectRate(tx: Tx, span: Span): Promise<number | null> {
    const where = { createdAt: { gte: span.from, lt: span.to }, kind: { in: ['pass', 'fail'] } };
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

  /** Each partner's fullest step type now: what its open jobs hold, of one period's capacity. */
  private async liveLoad(tx: Tx): Promise<WeekMetrics['partners']['load']> {
    const partners = await tx.partner.findMany({
      where: { capabilities: { some: {} } },
      select: { id: true, name: true, capabilities: { select: { stepTypeId: true, capacity: true } } },
    });
    if (partners.length === 0) return [];
    const loads = await this.eligibility.loads(tx, partners.map((partner) => partner.id));
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

  /** An earlier week's fullest day per partner, from the daily capacity snapshots (D83). */
  private async snapshotLoad(tx: Tx, span: Span): Promise<WeekMetrics['partners']['load']> {
    const rows = await tx.partnerCapacitySnapshot.findMany({
      where: { date: { gte: dateOnly(span.start), lt: dateOnly(addDays(span.start, 7)) }, capacity: { gt: 0 } },
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

  /** Per partner, the share of its accepted jobs due within the week that were done by their due date. */
  private async partnerOnTime(tx: Tx, span: Span, today: string): Promise<WeekMetrics['partners']['on_time']> {
    const jobs = await tx.jobAssignment.findMany({
      where: { status: 'accepted', dueOn: { gte: dateOnly(span.start), lt: dateOnly(addDays(span.start, 7)) } },
      select: {
        dueOn: true,
        partner: { select: { id: true, name: true } },
        group: { select: { workOrders: PIECES_WITH_FINISH } },
      },
    });
    const by = new Map<string, { id: string; name: string; lines: { promisedOn: string; readyOn: string | null }[] }>();
    for (const job of jobs) {
      const entry = by.get(job.partner.id) ?? { id: job.partner.id, name: job.partner.name, lines: [] };
      entry.lines.push({ promisedOn: dayOf(job.dueOn!), readyOn: this.readyOn(job.group.workOrders, span.timeZone) });
      by.set(job.partner.id, entry);
    }
    return [...by.values()]
      .map((entry) => ({ id: entry.id, name: entry.name, rate: onTimeRate(entry.lines, today) }))
      .filter((entry): entry is { id: string; name: string; rate: number } => entry.rate !== null)
      .sort((a, b) => a.rate - b.rate);
  }
}
