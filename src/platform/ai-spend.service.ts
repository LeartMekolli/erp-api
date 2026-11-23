import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { monthBounds } from '../modules/ai/ai-limit';
import { money } from '../modules/reporting/week-metrics';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const aiSpendQuerySchema = z
  .strictObject({
    // A UTC month, YYYY-MM; the current one when left out.
    month: z
      .string()
      .regex(MONTH, 'must be a month such as 2026-11')
      .optional(),
  })
  .refine((query) => query.month === undefined || query.month <= monthBounds(new Date()).key, {
    message: 'must not be after the current month',
    path: ['month'],
  });

export const aiSpendResponseSchema = z.strictObject({
  month: z.string().regex(MONTH),
  // Every UTC day of the month up to today, oldest first; `tenants` lists only the workspaces with spend that day.
  days: z.array(
    z.strictObject({
      date: z.iso.date(),
      total_usd: money,
      tenants: z.array(z.strictObject({ tenant_id: z.uuid(), usd: money })),
    }),
  ),
  // Every workspace, the biggest spender first. In USD, to the cent.
  tenants: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      monthly_limit_usd: money.nullable(),
      spent_usd: money,
    }),
  ),
});
export type AiSpendResponse = z.infer<typeof aiSpendResponseSchema>;

@Injectable()
export class AiSpendService {
  constructor(private readonly prisma: PrismaService) {}

  async spend(query: { month?: string }): Promise<AiSpendResponse> {
    const now = new Date();
    const current = monthBounds(now);
    const { start, end, key } = query.month ? monthBounds(new Date(`${query.month}-01T00:00:00Z`)) : current;
    // The UTC dates to answer: all of a past month, up to today in the current one.
    const lastDay = key === current.key ? now.getUTCDate() : new Date(end.getTime() - 86_400_000).getUTCDate();
    const dates = Array.from({ length: lastDay }, (_, index) =>
      new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), index + 1)).toISOString().slice(0, 10),
    );

    const tenants = await this.prisma.tenant.findMany({ select: { id: true, name: true, aiMonthlyLimitUsd: true } });
    const perDay = new Map<string, { tenantId: string; usd: Prisma.Decimal }[]>(dates.map((date) => [date, []]));
    const spent: { id: string; name: string; limit: string | null; usd: Prisma.Decimal }[] = [];

    for (const tenant of tenants) {
      // The run log is behind each workspace's row-level security: one read for each. `finished_at` holds UTC.
      const rows = await this.prisma.inTenant(tenant.id, (tx) =>
        tx.$queryRaw<{ day: string; usd: string }[]>(Prisma.sql`
          SELECT to_char(date_trunc('day', finished_at), 'YYYY-MM-DD') AS day, SUM(cost_usd)::text AS usd
          FROM ai_run_result
          WHERE finished_at >= ${start.toISOString().slice(0, 10)}::date
            AND finished_at < ${end.toISOString().slice(0, 10)}::date
          GROUP BY 1
        `),
      );
      let total = new Prisma.Decimal(0);
      for (const row of rows) {
        const usd = new Prisma.Decimal(row.usd);
        total = total.plus(usd);
        // A day after today cannot hold a result; a stray one is kept in the total only.
        perDay.get(row.day)?.push({ tenantId: tenant.id, usd });
      }
      spent.push({ id: tenant.id, name: tenant.name, limit: tenant.aiMonthlyLimitUsd?.toFixed(2) ?? null, usd: total });
    }

    return {
      month: key,
      days: dates.map((date) => {
        const entries = perDay.get(date) ?? [];
        return {
          date,
          total_usd: entries.reduce((sum, entry) => sum.plus(entry.usd), new Prisma.Decimal(0)).toFixed(2),
          tenants: entries
            .sort((a, b) => b.usd.comparedTo(a.usd) || a.tenantId.localeCompare(b.tenantId))
            .map((entry) => ({ tenant_id: entry.tenantId, usd: entry.usd.toFixed(2) })),
        };
      }),
      tenants: spent
        .sort((a, b) => b.usd.comparedTo(a.usd) || a.name.localeCompare(b.name))
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          monthly_limit_usd: entry.limit,
          spent_usd: entry.usd.toFixed(2),
        })),
    };
  }
}
