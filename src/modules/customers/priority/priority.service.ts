import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../../database/prisma.service';
import { Prisma } from '../../../generated/prisma/client';
import type { CustomerPriority } from '../../../generated/prisma/client';
import { AuditService } from '../../audit/audit.service';
import type { TenantAuth } from '../../identity/auth-context';
import { localDate, startOfLocalDay } from '../../orders/dates';
import { keySchema } from '../../pricing/decimals';
import { SettingsService } from '../../settings/settings.service';
import { WorkOrdersService } from '../../workflow/work-orders.service';
import {
  bandInForce,
  bandNamed,
  customerBand,
  isBandKey,
  overrideInForce,
  prioritySettings,
  privilegesOf,
  queueRankOf,
  workspaceToday,
} from './bands';
import type { PrioritySettings } from './bands';
import type { CustomerPriorityResponse } from './priority-response';
import { NO_PARTS, bandFor, percentileParts, scoreOf } from './score';
import type { History, Parts } from './score';

type Tx = Prisma.TransactionClient;

const DAY_MS = 86_400_000;
const RECENT_DAYS = 90;
const YEAR_DAYS = 365;
/**
 * A run reads every customer's history and writes every row in one transaction, so a score is never half
 * from one run and half from the next; a workspace of tens of thousands needs more than Prisma's 5 s.
 */
const REFRESH_TIMEOUT_MS = 60_000;

const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const dateOf = (day: string) => new Date(`${day}T00:00:00Z`);
const zero = () => new Prisma.Decimal(0);

export const priorityOverrideSchema = z.strictObject({
  /** A band of `customers.priority`, or its default band. */
  band_key: keySchema,
  reason: z.string().trim().min(1).max(500),
  /** The override's last day, in the workspace's zone; today or later. */
  ends_on: z.iso.date(),
});
export type PriorityOverrideInput = z.infer<typeof priorityOverrideSchema>;

/**
 * Customers' priority scores and bands (Customers 2 spec, goals 11–16). A score is relative to the
 * workspace's other customers, so it is always computed for the whole workspace at once.
 */
@Injectable()
export class PriorityService implements OnModuleInit {
  private readonly logger = new Logger(PriorityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly workOrders: WorkOrdersService,
  ) {}

  onModuleInit(): void {
    // A new group sorts by its customer's band from the start; Workflow never depends on Customers.
    this.workOrders.registerStartHook(async (tx, started) => {
      if (started.quote.customerId) await this.rankGroup(tx, started.groupId, started.quote.customerId);
      return undefined;
    });
    // Bands changing first-in-line, or their order, reorder the queue with the change.
    this.settings.onWrite('customers.priority', async (tx) => this.rerank(tx, (await workspaceToday(tx, new Date())).today));
  }

  /**
   * Sets every group's work queue rank from its customer's band in force on `today` (spec, goal 17):
   * `queueRankOf` for a first-in-line band, else 0. Called after a run, an override set or removed and a
   * change to the bands; an override that ends on its own is followed at the next nightly run. Only groups
   * whose rank changes are written, locked in id order as moves lock groups, so the two never deadlock.
   */
  async rerank(tx: Tx, today: string): Promise<void> {
    const settings = await prioritySettings(tx, this.settings);
    const firstInLine = settings.bands.filter((band) => band.firstInLine).map((band) => band.key);
    const rows =
      firstInLine.length === 0
        ? []
        : await tx.customerPriority.findMany({
            where: { OR: [{ bandKey: { in: firstInLine } }, { overrideBandKey: { in: firstInLine } }] },
            select: { customerId: true, bandKey: true, overrideBandKey: true, overrideEndsOn: true },
          });
    const customerIds: string[] = [];
    const ranks: number[] = [];
    for (const row of rows) {
      const rank = queueRankOf(bandInForce(row, today, settings).key, settings);
      if (rank > 0) {
        customerIds.push(row.customerId);
        ranks.push(rank);
      }
    }
    await tx.$executeRaw`
      WITH target AS (SELECT * FROM unnest(${customerIds}::uuid[], ${ranks}::int[]) AS t(customer_id, rank)),
      changed AS (
        SELECT g.id, COALESCE(t.rank, 0) AS rank
        FROM work_order_group g LEFT JOIN target t ON t.customer_id = g.customer_id
        WHERE g.queue_rank <> COALESCE(t.rank, 0)
        ORDER BY g.id
        FOR NO KEY UPDATE OF g
      )
      UPDATE work_order_group g SET queue_rank = changed.rank FROM changed WHERE g.id = changed.id`;
  }

  private async rankGroup(tx: Tx, groupId: string, customerId: string): Promise<void> {
    const settings = await prioritySettings(tx, this.settings);
    const rank = queueRankOf((await customerBand(tx, customerId, settings)).key, settings);
    if (rank > 0) await tx.workOrderGroup.update({ where: { id: groupId }, data: { queueRank: rank } });
  }

  /** Computes every active workspace not yet computed on its local today; one failing doesn't stop the others. */
  async refreshEverywhere(at: Date): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const tenant of tenants) {
      try {
        await this.refreshDue(tenant.id, at);
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'computing the priority scores failed for a workspace');
      }
    }
  }

  /**
   * Computes the workspace when none of its rows was computed on its local today, so the hourly job runs
   * it once a day, just after midnight there. True when it computed.
   */
  async refreshDue(tenantId: string, at: Date): Promise<boolean> {
    const due = await this.prisma.inTenant(tenantId, async (tx) => {
      const { today, timezone } = await workspaceToday(tx, at);
      return !(await tx.customerPriority.findFirst({ where: { computedAt: { gte: startOfLocalDay(today, timezone) } }, select: { customerId: true } }));
    });
    if (due) await this.refresh(tenantId, at);
    return due;
  }

  /**
   * Scores every customer of the workspace from its history as of `at`. Customers without an order in the
   * last 365 days aren't compared: score 0, parts 0 and the default band.
   */
  async refresh(tenantId: string, at: Date): Promise<void> {
    await this.prisma.inTenant(tenantId, async (tx) => {
      const settings = await prioritySettings(tx, this.settings);
      const histories = await this.histories(tx, at);
      const parts = percentileParts(histories);
      const customerIds: string[] = [];
      const scores: number[] = [];
      const partsJson: string[] = [];
      const bandKeys: (string | null)[] = [];
      for (const history of histories) {
        const own = parts.get(history.customerId);
        const score = own ? scoreOf(own, settings.weights) : 0;
        customerIds.push(history.customerId);
        scores.push(score);
        partsJson.push(JSON.stringify(own ?? NO_PARTS));
        bandKeys.push(own ? bandFor(score, settings.bands) : null);
      }
      // One statement for every customer; overrides are left as they are.
      await tx.$executeRaw`
        INSERT INTO customer_priority (customer_id, score, parts, band_key, computed_at)
        SELECT row.customer_id, row.score, row.parts::jsonb, row.band_key, ${at}
        FROM unnest(${customerIds}::uuid[], ${scores}::int[], ${partsJson}::text[], ${bandKeys}::text[])
          AS row(customer_id, score, parts, band_key)
        ON CONFLICT (tenant_id, customer_id) DO UPDATE
        SET score = EXCLUDED.score, parts = EXCLUDED.parts, band_key = EXCLUDED.band_key, computed_at = EXCLUDED.computed_at`;
      await this.rerank(tx, (await workspaceToday(tx, at)).today);
    }, { timeoutMs: REFRESH_TIMEOUT_MS });
  }

  async get(tenantId: string, customerId: string): Promise<CustomerPriorityResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      await this.findCustomer(tx, customerId);
      return this.read(tx, customerId);
    });
  }

  /** Recomputes the whole workspace now, since a score is relative, and answers this customer's. */
  async refreshFor(tenantId: string, customerId: string): Promise<CustomerPriorityResponse> {
    await this.prisma.inTenant(tenantId, (tx) => this.findCustomer(tx, customerId));
    await this.refresh(tenantId, new Date());
    return this.get(tenantId, customerId);
  }

  /**
   * Puts the customer in a band through a date, whatever its score. A customer the last run didn't reach
   * (created since) has no row to hold the override, so the workspace is computed first.
   */
  async setOverride(auth: TenantAuth, customerId: string, input: PriorityOverrideInput): Promise<CustomerPriorityResponse> {
    const reached = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.findCustomer(tx, customerId);
      return (await tx.customerPriority.count({ where: { customerId } })) > 0;
    });
    if (!reached) await this.refresh(auth.tenantId, new Date());

    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const settings = await prioritySettings(tx, this.settings);
      const { today } = await workspaceToday(tx, new Date());
      if (!isBandKey(input.band_key, settings)) {
        throw new BadRequestException({ message: 'Name a band of the workspace', errors: [{ path: 'band_key', message: 'not a band of customers.priority' }] });
      }
      if (input.ends_on < today) {
        throw new BadRequestException({ message: 'An override ends today or later', errors: [{ path: 'ends_on', message: 'is in the past' }] });
      }
      const before = await this.read(tx, customerId, settings, today);
      await tx.customerPriority.update({
        where: { tenantId_customerId: { tenantId: auth.tenantId, customerId } },
        data: { overrideBandKey: input.band_key, overrideReason: input.reason, overrideEndsOn: dateOf(input.ends_on), overrideByUserId: auth.userId },
      });
      const after = await this.read(tx, customerId, settings, today);
      await this.record(tx, auth, customerId, before, after);
      await this.rerank(tx, today);
      return after;
    });
  }

  /** The computed band is in force again at once. Nothing to remove is not an error. */
  async removeOverride(auth: TenantAuth, customerId: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.findCustomer(tx, customerId);
      const row = await tx.customerPriority.findUnique({ where: { tenantId_customerId: { tenantId: auth.tenantId, customerId } } });
      if (!row || row.overrideBandKey === null) return;
      const before = await this.read(tx, customerId);
      await tx.customerPriority.update({
        where: { tenantId_customerId: { tenantId: auth.tenantId, customerId } },
        data: { overrideBandKey: null, overrideReason: null, overrideEndsOn: null, overrideByUserId: null },
      });
      await this.record(tx, auth, customerId, before, await this.read(tx, customerId));
      await this.rerank(tx, (await workspaceToday(tx, new Date())).today);
    });
  }

  /** Spend, order count and invoices paid on time of every customer, as of `at`. */
  private async histories(tx: Tx, at: Date): Promise<History[]> {
    const { today, timezone } = await workspaceToday(tx, at);
    const [{ defaultCurrency: currency }] = await tx.$queryRaw<{ defaultCurrency: string }[]>`
      SELECT default_currency AS "defaultCurrency" FROM tenant WHERE id = current_setting('app.current_tenant_id')::uuid`;
    const recentFrom = new Date(at.getTime() - RECENT_DAYS * DAY_MS);
    const yearFrom = new Date(at.getTime() - YEAR_DAYS * DAY_MS);
    const placed = { cancelledAt: null, placedAt: { lte: at } };

    // Spend as the dashboard counts revenue: total less tax, in the workspace's currency, less completed refunds.
    const spend = async (from?: Date) => {
      const net = new Map<string, Prisma.Decimal>();
      const sums = await tx.order.groupBy({
        by: ['customerId'],
        where: { ...placed, currency, ...(from ? { placedAt: { gte: from, lte: at } } : {}) },
        _sum: { total: true, taxAmount: true },
      });
      for (const row of sums) net.set(row.customerId, (row._sum.total ?? zero()).sub(row._sum.taxAmount ?? zero()));
      const refunds = await tx.refund.findMany({
        where: { status: 'succeeded', order: { ...placed, currency, ...(from ? { placedAt: { gte: from, lte: at } } : {}) } },
        select: { amount: true, order: { select: { customerId: true } } },
      });
      for (const refund of refunds) net.set(refund.order.customerId, (net.get(refund.order.customerId) ?? zero()).sub(refund.amount));
      return net;
    };
    const lifetime = await spend();
    const recent = await spend(recentFrom);
    const counts = new Map(
      (
        await tx.order.groupBy({ by: ['customerId'], where: { cancelledAt: null, placedAt: { gte: yearFrom, lte: at } }, _count: { _all: true } })
      ).map((row) => [row.customerId, row._count._all]),
    );

    // Invoices due in the last 365 days: one counts once paid or past its due date, and is on time when paid by it.
    const invoices = await tx.invoice.findMany({
      where: { status: { in: ['open', 'paid'] }, dueOn: { gte: new Date(dateOf(today).getTime() - YEAR_DAYS * DAY_MS) } },
      select: { status: true, dueOn: true, paidAt: true, order: { select: { customerId: true } } },
    });
    const payment = new Map<string, { due: number; onTime: number }>();
    for (const invoice of invoices) {
      const dueOn = dayOf(invoice.dueOn);
      const paid = invoice.status === 'paid';
      if (!paid && dueOn >= today) continue;
      const onTime = paid && (invoice.paidAt === null || localDate(invoice.paidAt, timezone) <= dueOn);
      const own = payment.get(invoice.order.customerId) ?? { due: 0, onTime: 0 };
      payment.set(invoice.order.customerId, { due: own.due + 1, onTime: own.onTime + (onTime ? 1 : 0) });
    }

    const customers = await tx.customer.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    return customers.map(({ id }) => ({
      customerId: id,
      lifetime: lifetime.get(id) ?? zero(),
      recent: recent.get(id) ?? zero(),
      orders365: counts.get(id) ?? 0,
      invoicesDue: payment.get(id)?.due ?? 0,
      invoicesOnTime: payment.get(id)?.onTime ?? 0,
    }));
  }

  private async read(tx: Tx, customerId: string, settings?: PrioritySettings, today?: string): Promise<CustomerPriorityResponse> {
    const resolved = settings ?? (await prioritySettings(tx, this.settings));
    const day = today ?? (await workspaceToday(tx, new Date())).today;
    const row = await tx.customerPriority.findFirst({ where: { customerId } });
    return priorityResponse(row, day, resolved);
  }

  private async findCustomer(tx: Tx, customerId: string): Promise<void> {
    if (!(await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } }))) {
      throw new NotFoundException('Customer not found');
    }
  }

  private async record(tx: Tx, auth: TenantAuth, customerId: string, before: CustomerPriorityResponse, after: CustomerPriorityResponse): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'customer.priority_changed',
      subject: { type: 'customer', id: customerId },
      before: { override: before.override, band: before.band },
      after: { override: after.override, band: after.band },
    });
  }
}

/** A customer never computed reads score 0 and the default band. */
export function priorityResponse(row: CustomerPriority | null, today: string, settings: PrioritySettings): CustomerPriorityResponse {
  const inForce = bandInForce(row, today, settings);
  const privileges = privilegesOf(inForce.key, settings);
  return {
    score: row?.score ?? 0,
    parts: row ? (row.parts as unknown as Parts) : NO_PARTS,
    computed_band: bandNamed(row?.bandKey ?? null, settings),
    override:
      row && overrideInForce(row, today)
        ? { band: bandNamed(row.overrideBandKey, settings), reason: row.overrideReason!, ends_on: dayOf(row.overrideEndsOn!) }
        : null,
    band: { key: inForce.key, name: inForce.name },
    privileges: { first_in_line: privileges.firstInLine, may_pick_partner: privileges.mayPickPartner },
    computed_at: row?.computedAt.toISOString() ?? null,
  };
}
