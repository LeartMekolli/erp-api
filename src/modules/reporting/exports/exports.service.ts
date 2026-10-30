import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { decodeCursor } from '../../../common/pagination/cursor';
import { toPage } from '../../../common/pagination/page';
import type { Page } from '../../../common/pagination/page';
import { ConfigService } from '../../../config/config.service';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { JobsService } from '../../../jobs/jobs.service';
import { FilesService } from '../../files/files.service';
import type { TenantAuth } from '../../identity/auth-context';
import { isTenantPermission } from '../../identity/permissions';
import type { TenantPermission } from '../../identity/permissions';
import { NotificationsService } from '../../notifications/notifications.service';
import { localDate } from '../../orders/dates';
import { csvFile } from './csv';
import type { CsvCell } from './csv';
import { EXPORT_PERMISSION, EXPORT_ROW_LIMIT } from './export-kinds';
import type { ExportBuilder, ExportContext, ExportKind, ExportRequest } from './export-kinds';
import { toExportResponse } from './export-response';
import type { ExportDownload, ExportListQuery, ExportResponse } from './export-response';

const DAY_MS = 86_400_000;
/** How long an export's file is kept once ready (Reporting 2 spec, goal 4). */
const KEEP_MS = 30 * DAY_MS;

/** What a failed export tells its asker when the cause isn't one of ours. */
const COULD_NOT_MAKE = 'The export could not be made. Try again, or narrow the period.';

/** Thrown by a build that passes the row limit; the export fails at once, without retrying. */
class TooManyRows extends Error {
  constructor(limit: number) {
    super(`Too many rows (more than ${limit.toLocaleString('en')}): narrow the period`);
  }
}

/**
 * Exports (Reporting 2 spec): asked for here, built by the `reports.export` job from the permissions the
 * asker held when asking, stored as a file of theirs, downloaded only by them, removed after 30 days. The
 * row is the log, and stays.
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);
  private readonly builders = new Map<ExportKind, ExportBuilder>();
  /** The row limit; a test may lower it. */
  rowLimit = EXPORT_ROW_LIMIT;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jobs: JobsService,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Registers how a kind is built. One builder per kind. */
  register(builder: ExportBuilder): void {
    this.builders.set(builder.kind, builder);
  }

  /**
   * Logs the export and queues it. 403 without `report.export` or the kind's own permission. The asker's
   * permissions are copied onto the row: the file is built from those (Review Focus 2).
   */
  async start(auth: TenantAuth, request: ExportRequest): Promise<{ id: string }> {
    if (!auth.permissions.has('report.export') || !auth.permissions.has(EXPORT_PERMISSION[request.kind])) {
      throw new ForbiddenException(`Exporting ${request.kind} needs report.export and ${EXPORT_PERMISSION[request.kind]}`);
    }
    const row = await this.prisma.inTenant(auth.tenantId, (tx) =>
      tx.reportExport.create({
        data: {
          kind: request.kind,
          params: request.params as Prisma.InputJsonObject,
          permissions: [...auth.permissions],
          requestedByUserId: auth.userId,
        },
      }),
    );
    try {
      await this.jobs.enqueue('reports.export', { tenantId: auth.tenantId, exportId: row.id });
    } catch (error) {
      await this.fail(auth.tenantId, row.id, COULD_NOT_MAKE);
      throw error;
    }
    return { id: row.id };
  }

  /** One of the asker's exports; another's is a 404. */
  async get(auth: TenantAuth, id: string): Promise<ExportResponse> {
    return toExportResponse(await this.own(auth, id));
  }

  /** The asker's exports, newest first. */
  async list(auth: TenantAuth, query: ExportListQuery): Promise<Page<ExportResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    const rows = await this.prisma.inTenant(auth.tenantId, (tx) =>
      tx.reportExport.findMany({
        where: { requestedByUserId: auth.userId, ...(after ? { id: { lt: after.id } } : {}) },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      }),
    );
    return toPage(rows.map(toExportResponse), query.limit, secret);
  }

  /** A short-lived link to the asker's ready export; 409 until it is ready or once it has expired. */
  async downloadUrl(auth: TenantAuth, id: string): Promise<ExportDownload> {
    const row = await this.own(auth, id);
    if (row.status !== 'ready' || !row.fileId || !row.expiresAt || row.expiresAt <= new Date()) {
      throw new ConflictException(row.status === 'expired' || row.status === 'ready' ? 'Expired' : 'Not ready');
    }
    const fileId = row.fileId;
    const version = await this.prisma.inTenant(auth.tenantId, (tx) =>
      tx.fileVersion.findFirstOrThrow({ where: { fileId, number: 1 }, select: { id: true } }),
    );
    const link = await this.files.downloadUrl(auth.tenantId, fileId, version.id, { type: 'user', id: auth.userId });
    await this.prisma.inTenant(auth.tenantId, (tx) =>
      tx.reportExport.updateMany({ where: { id, downloadedAt: null }, data: { downloadedAt: new Date() } }),
    );
    return link;
  }

  /**
   * The `reports.export` job: builds the file, stores it as the asker's, and tells them. An export no
   * longer pending is left alone; one past the row limit fails at once.
   */
  async run(tenantId: string, exportId: string): Promise<void> {
    const { row, tenant } = await this.prisma.inTenant(tenantId, async (tx) => ({
      row: await tx.reportExport.findUnique({ where: { id: exportId } }),
      tenant: await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, defaultCurrency: true } }),
    }));
    if (!row || row.status !== 'pending') return;
    const builder = this.builders.get(row.kind as ExportKind);
    if (!builder) throw new Error(`No builder for exports of kind ${row.kind}`);

    const ctx: ExportContext = {
      tenantId,
      params: row.params,
      may: new Set(row.permissions.filter(isTenantPermission)) as ReadonlySet<TenantPermission>,
      timeZone: tenant.timezone,
      currency: tenant.defaultCurrency,
    };
    let bytes: Buffer;
    let rows: number | null = null;
    try {
      if (builder.format === 'csv') {
        const all: Record<string, CsvCell>[] = [];
        for await (const page of builder.pages(ctx)) {
          all.push(...page);
          if (all.length > this.rowLimit) throw new TooManyRows(this.rowLimit);
        }
        bytes = csvFile(builder.columns(ctx.may), all, ctx.timeZone);
        rows = all.length;
      } else {
        bytes = await builder.document(ctx);
      }
    } catch (error) {
      if (error instanceof TooManyRows) {
        await this.fail(tenantId, exportId, error.message);
        return;
      }
      throw error;
    }

    const extension = builder.format === 'csv' ? 'csv' : 'pdf';
    await this.files.storeGenerated(tenantId, {
      // The export's id: a retried job finds the file it wrote.
      fileId: exportId,
      owner: { type: 'user', id: row.requestedByUserId },
      name: `${row.kind}-${localDate(row.createdAt, ctx.timeZone)}.${extension}`,
      bytes,
      contentType: builder.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
      createdByUserId: row.requestedByUserId,
      kind: 'document',
    });
    const finishedAt = new Date();
    const updated = await this.prisma.inTenant(tenantId, (tx) =>
      tx.reportExport.updateMany({
        where: { id: exportId, status: 'pending' },
        data: { status: 'ready', rows, fileId: exportId, finishedAt, expiresAt: new Date(finishedAt.getTime() + KEEP_MS) },
      }),
    );
    if (updated.count === 1) await this.tell(tenantId, 'report.export_ready', row.requestedByUserId, exportId, row.kind);
  }

  /** After the job's last attempt, or a build past the row limit: failed, with a plain message, and the asker told. */
  async fail(tenantId: string, exportId: string, message: string): Promise<void> {
    const row = await this.prisma.inTenant(tenantId, async (tx) => {
      const failed = await tx.reportExport.updateMany({
        where: { id: exportId, status: 'pending' },
        data: { status: 'failed', error: message, finishedAt: new Date() },
      });
      return failed.count === 1 ? tx.reportExport.findUnique({ where: { id: exportId } }) : null;
    });
    if (row) await this.tell(tenantId, 'report.export_failed', row.requestedByUserId, exportId, row.kind);
  }

  /** The dead letter's message for the asker: never the job's raw error. */
  failedPlainly(tenantId: string, exportId: string): Promise<void> {
    return this.fail(tenantId, exportId, COULD_NOT_MAKE);
  }

  /** The scheduled clean-up: every ready export past its expiry loses its file and becomes `expired`. */
  async expireDue(at: Date): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const tenant of tenants) {
      try {
        await this.expireDueIn(tenant.id, at);
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'removing expired exports failed');
      }
    }
  }

  /** `expireDue` in one workspace. */
  async expireDueIn(tenantId: string, at: Date): Promise<number> {
    const due = await this.prisma.inTenant(tenantId, (tx) =>
      tx.reportExport.findMany({ where: { status: 'ready', expiresAt: { lte: at } }, select: { id: true, fileId: true, requestedByUserId: true } }),
    );
    for (const row of due) {
      if (row.fileId) {
        try {
          await this.files.remove(tenantId, row.fileId, { type: 'user', id: row.requestedByUserId });
        } catch (error) {
          // Already removed by an earlier run that stopped before marking it.
          if (!(error instanceof NotFoundException)) throw error;
        }
      }
      await this.prisma.inTenant(tenantId, (tx) => tx.reportExport.updateMany({ where: { id: row.id, status: 'ready' }, data: { status: 'expired' } }));
    }
    return due.length;
  }

  private async own(auth: TenantAuth, id: string) {
    const row = await this.prisma.inTenant(auth.tenantId, (tx) =>
      tx.reportExport.findFirst({ where: { id, requestedByUserId: auth.userId } }),
    );
    if (!row) throw new NotFoundException('Export not found');
    return row;
  }

  private async tell(
    tenantId: string,
    event: 'report.export_ready' | 'report.export_failed',
    userId: string,
    exportId: string,
    kind: string,
  ): Promise<void> {
    try {
      await this.notifications.raise(tenantId, event, { type: 'user', id: userId }, { export_id: exportId, kind });
    } catch (error) {
      this.logger.error({ err: error, tenantId, exportId }, 'telling the asker about an export failed');
    }
  }
}
