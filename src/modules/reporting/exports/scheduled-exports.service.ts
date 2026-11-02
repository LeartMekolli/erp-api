import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { newId } from '../../../common/ids/uuid';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { JobsService } from '../../../jobs/jobs.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { localDate } from '../../orders/dates';
import type { SettingValue } from '../../settings/setting-keys';
import { SettingsService } from '../../settings/settings.service';
import { EXPORT_PERMISSION } from './export-kinds';
import type { ExportKind } from './export-kinds';
import { ExportsService } from './exports.service';

type Tx = Prisma.TransactionClient;

/** Each schedule of `reports.schedules`: what it is called in its message, and the kinds it makes. */
const SCHEDULES = {
  accounting: { name: 'accounting', kinds: ['accounting_invoices', 'accounting_payments', 'accounting_payouts', 'accounting_refunds'] },
  top_customers: { name: 'top customers', kinds: ['top_customers'] },
} as const satisfies Record<keyof SettingValue<'reports.schedules'>, { name: string; kinds: readonly ExportKind[] }>;
type Schedule = keyof typeof SCHEDULES;

/** `YYYY-MM` of the month before the one `date` (YYYY-MM-DD) is in. */
export function monthBefore(date: string): string {
  const [year, month] = date.split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/** The last day of `month` (YYYY-MM). */
function lastDayOf(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

/** What a scheduled export of `kind` covers: last month. */
function paramsFor(kind: ExportKind, month: string): Prisma.InputJsonObject {
  return kind === 'top_customers' ? { from: `${month}-01`, to: lastDayOf(month) } : { month };
}

/**
 * Monthly exports (Orders 3 spec, goal 10): on or after each workspace's local 1st, last month's files of
 * every enabled schedule, made once each by their `schedule_key`, with no requester and only the
 * permissions their kind needs. Built by the `reports.export` job as any export; once a schedule's month
 * is all ready, each recipient who may still read it is told, once.
 */
@Injectable()
export class ScheduledExportsService implements OnModuleInit {
  private readonly logger = new Logger(ScheduledExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly exports: ExportsService,
  ) {}

  onModuleInit(): void {
    this.exports.onScheduledReady((tenantId, exportId) => this.tellIfMonthReady(tenantId, exportId));
  }

  /** The hourly `reports.schedules` job: every active workspace; one failing doesn't stop the others. */
  async runEverywhere(at: Date): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const tenant of tenants) {
      try {
        await this.runDue(tenant.id, at);
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'making the scheduled exports failed for a workspace');
      }
    }
  }

  /**
   * Makes and queues last month's exports of each enabled schedule not made yet; answers their keys. A
   * key taken already (the unique `schedule_key`) was made by an earlier run. One that can't be queued is
   * taken back, so the next run makes it again.
   */
  async runDue(tenantId: string, at: Date): Promise<string[]> {
    const made = await this.prisma.inTenant(tenantId, async (tx) => {
      const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
      const month = monthBefore(localDate(at, timezone));
      const schedules = (await this.settings.list(tx))['reports.schedules'] as SettingValue<'reports.schedules'> | undefined;
      const rows: { id: string; key: string }[] = [];
      for (const schedule of Object.keys(SCHEDULES) as Schedule[]) {
        if (!schedules?.[schedule].enabled) continue;
        for (const kind of SCHEDULES[schedule].kinds) {
          const row = { id: newId(), key: `${kind}:${month}` };
          const created = await tx.reportExport.createMany({
            data: [{ id: row.id, kind, params: paramsFor(kind, month), permissions: ['report.export', EXPORT_PERMISSION[kind]], scheduleKey: row.key }],
            skipDuplicates: true,
          });
          if (created.count === 1) rows.push(row);
        }
      }
      return rows;
    });

    const queued: string[] = [];
    for (const row of made) {
      try {
        await this.jobs.enqueue('reports.export', { tenantId, exportId: row.id });
        queued.push(row.key);
      } catch (error) {
        this.logger.error({ err: error, tenantId, key: row.key }, 'queueing a scheduled export failed; the next run makes it again');
        await this.prisma.inTenant(tenantId, (tx) => tx.reportExport.deleteMany({ where: { id: row.id, status: 'pending' } }));
      }
    }
    return queued;
  }

  /**
   * Once every export of a schedule's month is ready, tells each recipient who still holds `report.export`
   * and the kinds' permission, once: under a lock per schedule and month, a message already stored for it
   * means it was told.
   */
  async tellIfMonthReady(tenantId: string, exportId: string): Promise<void> {
    const notificationIds = await this.prisma.inTenant(tenantId, async (tx) => {
      const row = await tx.reportExport.findUnique({ where: { id: exportId }, select: { kind: true, scheduleKey: true } });
      if (!row?.scheduleKey) return [];
      const month = row.scheduleKey.slice(row.scheduleKey.indexOf(':') + 1);
      const schedule = (Object.keys(SCHEDULES) as Schedule[]).find((one) => (SCHEDULES[one].kinds as readonly string[]).includes(row.kind));
      if (!schedule) return [];
      const { name, kinds } = SCHEDULES[schedule];

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:export_schedule:${schedule}:${month}`}::text, 0))`;
      const rows = await tx.reportExport.findMany({
        where: { scheduleKey: { in: kinds.map((kind) => `${kind}:${month}`) } },
        orderBy: { kind: 'asc' },
        select: { id: true, kind: true, status: true },
      });
      if (rows.length !== kinds.length || rows.some((one) => one.status !== 'ready')) return [];
      const told = await tx.notification.findFirst({
        where: { eventKey: 'export.scheduled_ready', AND: [{ payload: { path: ['schedule'], equals: name } }, { payload: { path: ['month'], equals: month } }] },
        select: { id: true },
      });
      if (told) return [];

      const recipients = await this.recipients(tx, schedule, EXPORT_PERMISSION[kinds[0]]);
      const exports = rows.map((one) => `${one.kind}: ${one.id}`).join('\n');
      const ids: string[] = [];
      for (const userId of recipients) {
        ids.push(await this.notifications.store(tx, 'export.scheduled_ready', { type: 'user', id: userId }, { schedule: name, month, exports }));
      }
      return ids;
    });
    for (const id of notificationIds) await this.notifications.queue(tenantId, id);
  }

  /** The schedule's recipients who are active and may still read its files. */
  private async recipients(tx: Tx, schedule: Schedule, permission: string): Promise<string[]> {
    const schedules = (await this.settings.list(tx))['reports.schedules'] as SettingValue<'reports.schedules'> | undefined;
    const ids = schedules?.[schedule].recipientUserIds ?? [];
    if (ids.length === 0) return [];
    const holds = (one: string): Prisma.UserWhereInput => ({ roles: { some: { role: { permissions: { some: { permission: one } } } } } });
    const users = await tx.user.findMany({
      where: { id: { in: ids }, status: 'active', AND: [holds('report.export'), holds(permission)] },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return users.map((user) => user.id);
  }
}
