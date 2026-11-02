import { Injectable, OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { PrismaService } from '../../../database/prisma.service';
import { Prisma } from '../../../generated/prisma/client';
import { bandInForce, prioritySettings } from '../../customers/priority/bands';
import { localDate, startOfLocalDay } from '../../orders/dates';
import { SettingsService } from '../../settings/settings.service';
import { addDays } from '../week-metrics';
import type { CsvCell, CsvColumn } from './csv';
import type { CsvBuilder, ExportContext, topCustomersParamsSchema } from './export-kinds';
import { ExportsService } from './exports.service';

type Params = z.infer<typeof topCustomersParamsSchema>;
type Tx = Prisma.TransactionClient;

const DAY_MS = 86_400_000;
const zero = () => new Prisma.Decimal(0);

/** Per customer, its orders placed in the span, not cancelled, and their revenue net of tax in `currency`, as the dashboard counts it. */
async function ordersBy(tx: Tx, span: { gte: Date; lt: Date }, currency: string): Promise<Map<string, { orders: number; revenue: Prisma.Decimal }>> {
  const groups = await tx.order.groupBy({
    by: ['customerId', 'currency'],
    where: { cancelledAt: null, placedAt: span },
    _count: { _all: true },
    _sum: { total: true, taxAmount: true },
  });
  const by = new Map<string, { orders: number; revenue: Prisma.Decimal }>();
  for (const group of groups) {
    const entry = by.get(group.customerId) ?? { orders: 0, revenue: zero() };
    entry.orders += group._count._all;
    if (group.currency === currency) entry.revenue = entry.revenue.add(group._sum.total ?? 0).sub(group._sum.taxAmount ?? 0);
    by.set(group.customerId, entry);
  }
  return by;
}

/**
 * Top customers (Orders 3 spec, goal 9): the customers who ordered in the range, by revenue, most first,
 * with their orders and revenue in the period of the same length just before, their customer group and
 * band, and the claims opened and remakes decided on their orders in the range.
 */
@Injectable()
export class TopCustomersExport implements CsvBuilder<Params>, OnModuleInit {
  readonly kind = 'top_customers';
  readonly format = 'csv';

  constructor(
    private readonly prisma: PrismaService,
    private readonly exports: ExportsService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.exports.register(this as CsvBuilder);
  }

  columns(): CsvColumn[] {
    return [
      { key: 'id', label: 'Customer ID' },
      { key: 'name', label: 'Customer' },
      { key: 'customer_group', label: 'Customer group' },
      { key: 'band', label: 'Band' },
      { key: 'orders', label: 'Orders' },
      { key: 'revenue', label: 'Revenue (net)' },
      { key: 'previous_orders', label: 'Orders before' },
      { key: 'previous_revenue', label: 'Revenue before (net)' },
      { key: 'claims', label: 'Claims' },
      { key: 'remakes', label: 'Remakes' },
      { key: 'currency', label: 'Currency' },
    ];
  }

  /**
   * One customer a row, so the list is read whole and ranked, then handed out in pages: it holds only the
   * customers who ordered in the range.
   */
  async *pages(ctx: ExportContext<Params>): AsyncIterable<Record<string, CsvCell>[]> {
    const days = (new Date(`${ctx.params.to}T00:00:00Z`).getTime() - new Date(`${ctx.params.from}T00:00:00Z`).getTime()) / DAY_MS + 1;
    const span = { gte: startOfLocalDay(ctx.params.from, ctx.timeZone), lt: startOfLocalDay(addDays(ctx.params.to, 1), ctx.timeZone) };
    const before = { gte: startOfLocalDay(addDays(ctx.params.from, -days), ctx.timeZone), lt: span.gte };

    const rows = await this.prisma.inTenant(ctx.tenantId, async (tx) => {
      const now = await ordersBy(tx, span, ctx.currency);
      const earlier = await ordersBy(tx, before, ctx.currency);
      const ids = [...now.keys()];
      const customers = await tx.customer.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, customerGroup: { select: { name: true } } },
      });
      const priorities = await tx.customerPriority.findMany({
        where: { customerId: { in: ids } },
        select: { customerId: true, bandKey: true, overrideBandKey: true, overrideEndsOn: true },
      });
      const settings = await prioritySettings(tx, this.settings);
      const today = localDate(new Date(), ctx.timeZone);
      const claims = await tx.claim.findMany({
        where: { order: { customerId: { in: ids } }, createdAt: span },
        select: { order: { select: { customerId: true } } },
      });
      const remakes = await tx.claimLine.findMany({
        where: { outcome: 'remake', decidedAt: span, claim: { order: { customerId: { in: ids } } } },
        select: { claim: { select: { order: { select: { customerId: true } } } } },
      });
      const count = (customerIds: string[], id: string) => customerIds.filter((one) => one === id).length;

      return customers
        .map((customer) => {
          const mine = now.get(customer.id)!;
          const previous = earlier.get(customer.id) ?? { orders: 0, revenue: zero() };
          return {
            id: customer.id,
            name: customer.name,
            customer_group: customer.customerGroup?.name ?? null,
            band: bandInForce(priorities.find((row) => row.customerId === customer.id) ?? null, today, settings).name,
            orders: mine.orders,
            revenue: mine.revenue,
            previous_orders: previous.orders,
            previous_revenue: previous.revenue,
            claims: count(claims.map((claim) => claim.order.customerId), customer.id),
            remakes: count(remakes.map((line) => line.claim.order.customerId), customer.id),
            currency: ctx.currency,
          };
        })
        .sort((a, b) => b.revenue.cmp(a.revenue) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    });

    for (let start = 0; start < rows.length; start += ctx.pageSize) {
      yield rows.slice(start, start + ctx.pageSize);
    }
  }
}
