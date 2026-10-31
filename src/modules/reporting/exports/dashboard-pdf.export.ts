import { Injectable, OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { PrismaService } from '../../../database/prisma.service';
import { localDateTime } from '../../orders/dates';
import { ReportsService } from '../reports.service';
import { dashboardDocument, renderPdf } from './dashboard-pdf';
import type { ExportContext, PdfBuilder, dashboardPdfParamsSchema } from './export-kinds';
import { ExportsService } from './exports.service';

type Params = z.infer<typeof dashboardPdfParamsSchema>;

/**
 * The dashboard as a PDF for any dates (Reporting 2 spec, goals 14–16): the range's numbers, worked out
 * from the records, laid out for the asker's permissions when they asked.
 */
@Injectable()
export class DashboardPdfExport implements PdfBuilder<Params>, OnModuleInit {
  readonly kind = 'dashboard_pdf';
  readonly format = 'pdf';

  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly exports: ExportsService,
  ) {}

  onModuleInit(): void {
    this.exports.register(this as PdfBuilder);
  }

  async document(ctx: ExportContext<Params>): Promise<Buffer> {
    const madeAt = new Date();
    const metrics = await this.reports.metricsFor(ctx.tenantId, { from: ctx.params.from, to: ctx.params.to }, madeAt);
    const { name } = await this.prisma.inTenant(ctx.tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { name: true } }),
    );
    return renderPdf(
      dashboardDocument({
        workspace: name,
        from: ctx.params.from,
        to: ctx.params.to,
        madeAt: localDateTime(madeAt, ctx.timeZone),
        metrics,
        may: ctx.may,
      }),
    );
  }
}
