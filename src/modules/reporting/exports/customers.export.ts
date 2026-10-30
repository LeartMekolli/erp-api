import { Injectable, OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { PrismaService } from '../../../database/prisma.service';
import { Prisma } from '../../../generated/prisma/client';
import type { TenantPermission } from '../../identity/permissions';
import { localDate, startOfLocalDay } from '../../orders/dates';
import { PLAN_GIVING_STATUSES } from '../../payments/plans/plan-of';
import { addDays } from '../week-metrics';
import type { CsvCell, CsvColumn } from './csv';
import { PAGE_SIZE } from './export-kinds';
import type { CsvBuilder, ExportContext, customersParamsSchema } from './export-kinds';
import { ExportsService } from './exports.service';

type Params = z.infer<typeof customersParamsSchema>;

/**
 * The customer list (Reporting 2 spec, goal 12), by name: plan, payment terms, and the orders placed in
 * the range (all time without one), cancelled ones left out. Revenue, net of tax in the workspace's
 * currency as the dashboard counts it, only with `payment.read`.
 */
@Injectable()
export class CustomersExport implements CsvBuilder<Params>, OnModuleInit {
  readonly kind = 'customers';
  readonly format = 'csv';

  constructor(
    private readonly prisma: PrismaService,
    private readonly exports: ExportsService,
  ) {}

  onModuleInit(): void {
    this.exports.register(this as CsvBuilder);
  }

  columns(may: ReadonlySet<TenantPermission>): CsvColumn[] {
    return [
      { key: 'id', label: 'Customer ID' },
      { key: 'name', label: 'Name' },
      { key: 'status', label: 'Status' },
      { key: 'plan', label: 'Plan' },
      { key: 'payment_terms', label: 'Payment terms' },
      { key: 'created_on', label: 'Created on' },
      { key: 'orders', label: 'Orders' },
      ...(may.has('payment.read')
        ? [
            { key: 'revenue', label: 'Revenue (net)' },
            { key: 'currency', label: 'Currency' },
          ]
        : []),
    ];
  }

  async *pages(ctx: ExportContext<Params>): AsyncIterable<Record<string, CsvCell>[]> {
    const placedAt =
      ctx.params.from && ctx.params.to
        ? { gte: startOfLocalDay(ctx.params.from, ctx.timeZone), lt: startOfLocalDay(addDays(ctx.params.to, 1), ctx.timeZone) }
        : undefined;
    const defaultPlan = await this.prisma.inTenant(ctx.tenantId, (tx) =>
      tx.plan.findFirstOrThrow({ where: { isDefault: true }, select: { name: true } }),
    );

    for (let skip = 0; ; skip += PAGE_SIZE) {
      const page = await this.prisma.inTenant(ctx.tenantId, async (tx) => {
        const customers = await tx.customer.findMany({
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          skip,
          take: PAGE_SIZE,
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            paymentTerms: { select: { terms: true } },
            subscription: { select: { status: true, planPrice: { select: { plan: { select: { name: true } } } } } },
          },
        });
        const ids = customers.map((customer) => customer.id);
        const orders = await tx.order.groupBy({
          by: ['customerId', 'currency'],
          where: { customerId: { in: ids }, cancelledAt: null, ...(placedAt ? { placedAt } : {}) },
          _count: { _all: true },
          _sum: { total: true, taxAmount: true },
        });
        return { customers, orders };
      });

      yield page.customers.map((customer) => {
        const mine = page.orders.filter((group) => group.customerId === customer.id);
        const revenue = mine
          .filter((group) => group.currency === ctx.currency)
          .reduce((sum, group) => sum.add(group._sum.total ?? 0).sub(group._sum.taxAmount ?? 0), new Prisma.Decimal(0));
        const subscribed =
          customer.subscription && (PLAN_GIVING_STATUSES as readonly string[]).includes(customer.subscription.status)
            ? customer.subscription.planPrice.plan.name
            : null;
        return {
          id: customer.id,
          name: customer.name,
          status: customer.status,
          plan: subscribed ?? defaultPlan.name,
          payment_terms: customer.paymentTerms?.terms ?? 'pay_first',
          created_on: localDate(customer.createdAt, ctx.timeZone),
          orders: mine.reduce((count, group) => count + group._count._all, 0),
          revenue,
          currency: ctx.currency,
        };
      });
      if (page.customers.length < PAGE_SIZE) return;
    }
  }
}
