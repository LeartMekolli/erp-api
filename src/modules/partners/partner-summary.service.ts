import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { PartnerAuth } from '../identity/auth-context';
import { localDate, startOfLocalDay } from '../orders/dates';
import { bucketsFor, foldDays, pickBucket, previousRange } from '../reporting/range-buckets';
import type { RangeQuery } from '../reporting/range-buckets';
import { addDays } from '../reporting/week-metrics';
import { finishedBetween, owedBetween } from './owed-dates';
import type { OwedEntry } from './owed-dates';
import type { PartnerSummaryResponse } from './partner-summary-response';
import { atLeast } from './partner-roles';

type Tx = Prisma.TransactionClient;

interface PaidOwed {
  paid: Prisma.Decimal;
  owed: Prisma.Decimal;
}
const zero = () => new Prisma.Decimal(0);
const emptyPaidOwed = (): PaidOwed => ({ paid: zero(), owed: zero() });
const addPaidOwed = (a: PaidOwed, b: PaidOwed): PaidOwed => ({ paid: a.paid.add(b.paid), owed: a.owed.add(b.owed) });

/** The partner's active pieces now at each step it does, on track or late (a job past its `due_on`). */
async function stepsNow(tx: Tx, partnerId: string, today: string): Promise<PartnerSummaryResponse['steps']> {
  return tx.$queryRaw<PartnerSummaryResponse['steps']>`
    SELECT ws.key AS key,
           ws.name AS name,
           count(*) FILTER (WHERE ja.due_on IS NULL OR ja.due_on >= ${today}::date)::int AS on_track,
           count(*) FILTER (WHERE ja.due_on < ${today}::date)::int AS late
    FROM job_assignment ja
    JOIN work_order wo ON wo.group_id = ja.group_id
    JOIN workflow_step ws ON ws.id = wo.current_step_id
    WHERE ja.partner_id = ${partnerId}::uuid AND ja.status = 'accepted'
      AND wo.status = 'active' AND ws.done_by = 'partner'
    GROUP BY ws.key, ws.name
    ORDER BY min(ws.position), ws.name`;
}

/** What each local day's entries were worth: what a payout holds as paid, the rest as owed. */
function perDay(entries: OwedEntry[], timeZone: string): Map<string, PaidOwed> {
  const days = new Map<string, PaidOwed>();
  for (const entry of entries) {
    const paid = Prisma.Decimal.min(entry.paid, entry.amount);
    const day = localDate(entry.at, timeZone);
    days.set(day, addPaidOwed(days.get(day) ?? emptyPaidOwed(), { paid, owed: entry.amount.sub(paid) }));
  }
  return days;
}

/** The partner's own dashboard numbers (dashboard data spec, "Partner summary"): never the customer, the order or its price. */
@Injectable()
export class PartnerSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(auth: PartnerAuth, query: RangeQuery, at: Date = new Date()): Promise<PartnerSummaryResponse> {
    const dates = { from: query.from, to: query.to };
    const before = previousRange(dates);
    const bucket = pickBucket(dates, query.bucket);
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { timezone: true, defaultCurrency: true } });
      const zone = tenant.timezone;
      // `to` is inclusive: the period ends where the next local day begins.
      const instants = (range: { from: string; to: string }) => ({
        from: startOfLocalDay(range.from, zone),
        to: startOfLocalDay(addDays(range.to, 1), zone),
      });
      const current = instants(dates);
      const earlier = instants(before);

      const response: PartnerSummaryResponse = {
        range: { from: dates.from, to: dates.to, previous_from: before.from, previous_to: before.to, bucket },
        jobs_finished: await finishedBetween(tx, auth.partnerId, current.from, current.to),
        previous_jobs_finished: await finishedBetween(tx, auth.partnerId, earlier.from, earlier.to),
        steps: await stepsNow(tx, auth.partnerId, localDate(at, zone)),
      };
      if (!atLeast(auth.role, 'admin')) return response;

      // The previous period ends where this one begins: one read covers both.
      const entries = await owedBetween(tx, earlier.from, current.to, auth.partnerId);
      const total = (list: OwedEntry[]) => list.reduce((sum, entry) => sum.add(entry.amount), zero());
      const spans = bucketsFor(dates, bucket);
      const points = foldDays(
        spans,
        perDay(
          entries.filter((entry) => entry.at >= current.from),
          zone,
        ),
        emptyPaidOwed,
        addPaidOwed,
      );
      return {
        ...response,
        earned: total(entries.filter((entry) => entry.at >= current.from)).toFixed(2),
        previous_earned: total(entries.filter((entry) => entry.at < current.from)).toFixed(2),
        currency: tenant.defaultCurrency,
        series: spans.map((span, index) => ({
          start: span.start,
          days: span.days,
          paid: points[index].paid.toFixed(2),
          owed: points[index].owed.toFixed(2),
        })),
      };
    });
  }
}
