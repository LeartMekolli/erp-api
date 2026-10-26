import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma, TaxRate } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { percentSchema } from '../pricing/decimals';
import type { TaxRateResponse, TaxRatesResponse } from './order-response';

export const taxRatesSchema = z.object({
  rates: z
    .array(
      z.object({
        /** ISO 3166-1 alpha-2, upper case; null for the default rate. */
        country: z.string().regex(/^[A-Z]{2}$/, 'an ISO 3166-1 alpha-2 country code, such as DE').nullable(),
        /** Only with a country; null for the whole country. */
        region: z.string().trim().min(1).max(100).nullable(),
        percent: percentSchema(0, 100),
      }),
    )
    .max(500)
    .superRefine((rates, context) => {
      const seen = new Set<string>();
      rates.forEach((rate, index) => {
        if (rate.region !== null && rate.country === null) {
          context.addIssue({ code: 'custom', path: [index, 'region'], message: 'a region needs a country' });
        }
        const place = `${rate.country ?? ''}|${rate.region ?? ''}`;
        if (seen.has(place)) {
          context.addIssue({ code: 'custom', path: [index], message: 'each place, and the default, has one rate' });
        }
        seen.add(place);
      });
    }),
});

function toRate(row: TaxRate): TaxRateResponse {
  return { country: row.country, region: row.region, percent: row.percent.toFixed() };
}

/** The workspace's tax rates per country and region, with a default (Orders spec, goal 10). */
@Injectable()
export class TaxRatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<TaxRatesResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => ({ data: await this.all(tx) }));
  }

  /** Replaces the whole list. */
  async replace(auth: TenantAuth, input: z.infer<typeof taxRatesSchema>): Promise<TaxRatesResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      // Two replacements at once would each keep their own list; the second waits here instead.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${auth.tenantId}:tax_rates`}::text, 0))`;
      const before = await this.all(tx);
      await tx.taxRate.deleteMany({});
      await tx.taxRate.createMany({ data: input.rates });
      const after = await this.all(tx);
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'pricing.changed',
        subject: { type: 'tax_rates' },
        before: { data: before },
        after: { data: after },
      });
      return { data: after };
    });
  }

  /** The default first, then by country and region. */
  private async all(tx: Prisma.TransactionClient): Promise<TaxRateResponse[]> {
    const rows = await tx.taxRate.findMany({
      orderBy: [{ country: { sort: 'asc', nulls: 'first' } }, { region: { sort: 'asc', nulls: 'first' } }],
    });
    return rows.map(toRate);
  }
}
