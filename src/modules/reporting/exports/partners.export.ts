import { Injectable, OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { PrismaService } from '../../../database/prisma.service';
import { localDate } from '../../orders/dates';
import { EligibilityService } from '../../partners/eligibility.service';
import { partnerLoads, partnerOnTimeBetween } from '../reports.service';
import { addDays } from '../week-metrics';
import type { CsvCell, CsvColumn } from './csv';
import type { CsvBuilder, ExportContext, partnersParamsSchema } from './export-kinds';
import { ExportsService } from './exports.service';

type Params = z.infer<typeof partnersParamsSchema>;

/** The days the on-time rate looks back over, today included. */
const ON_TIME_DAYS = 90;

/**
 * The partner list (Reporting 2 spec, goal 13), by name, optionally of one status: what each can do, its
 * open jobs and fullest step now, and its on-time rate over the last 90 days as the dashboard counts it.
 * Needs `partner.read`, the kind's own permission, so no column depends on another.
 */
@Injectable()
export class PartnersExport implements CsvBuilder<Params>, OnModuleInit {
  readonly kind = 'partners';
  readonly format = 'csv';

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
    private readonly exports: ExportsService,
  ) {}

  onModuleInit(): void {
    this.exports.register(this as CsvBuilder);
  }

  columns(): CsvColumn[] {
    return [
      { key: 'id', label: 'Partner ID' },
      { key: 'name', label: 'Name' },
      { key: 'display_name', label: 'Display name' },
      { key: 'status', label: 'Status' },
      { key: 'capabilities', label: 'Capabilities' },
      { key: 'max_open_jobs', label: 'Max open jobs' },
      { key: 'open_jobs', label: 'Open jobs' },
      { key: 'load_percent', label: 'Load %' },
      { key: 'on_time_rate', label: 'On-time rate (90 days)' },
      { key: 'agreement_signed_on', label: 'Agreement signed on' },
    ];
  }

  async *pages(ctx: ExportContext<Params>): AsyncIterable<Record<string, CsvCell>[]> {
    const today = localDate(new Date(), ctx.timeZone);
    const { loads, onTime } = await this.prisma.inTenant(ctx.tenantId, async (tx) => ({
      loads: new Map((await partnerLoads(tx, this.eligibility)).map((row) => [row.id, row.percent])),
      onTime: new Map(
        (await partnerOnTimeBetween(tx, { from: addDays(today, 1 - ON_TIME_DAYS), until: addDays(today, 1) }, today, ctx.timeZone)).map(
          (row) => [row.id, row.rate],
        ),
      ),
    }));

    for (let last: { name: string; id: string } | undefined; ; ) {
      const after = last;
      const page = await this.prisma.inTenant(ctx.tenantId, async (tx) => {
        const partners = await tx.partner.findMany({
          where: {
            ...(ctx.params.status ? { status: ctx.params.status } : {}),
            ...(after ? { OR: [{ name: { gt: after.name } }, { name: after.name, id: { gt: after.id } }] } : {}),
          },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          take: ctx.pageSize,
          include: { capabilities: { select: { stepType: { select: { name: true } } } } },
        });
        return { partners, open: await this.eligibility.openJobs(tx, partners.map((partner) => partner.id)) };
      });

      yield page.partners.map((partner) => {
        const rate = onTime.get(partner.id);
        return {
          id: partner.id,
          name: partner.name,
          display_name: partner.displayName,
          status: partner.status,
          capabilities: [...new Set(partner.capabilities.map((capability) => capability.stepType.name))].sort().join('; '),
          max_open_jobs: partner.maxOpenJobs,
          open_jobs: page.open.get(partner.id) ?? 0,
          load_percent: loads.get(partner.id) ?? 0,
          // A share, written as a decimal a spreadsheet can format; empty with nothing due.
          on_time_rate: rate === undefined ? null : rate.toFixed(3),
          agreement_signed_on: partner.agreementSignedOn?.toISOString().slice(0, 10) ?? null,
        };
      });
      if (page.partners.length < ctx.pageSize) return;
      last = page.partners[page.partners.length - 1];
    }
  }
}
