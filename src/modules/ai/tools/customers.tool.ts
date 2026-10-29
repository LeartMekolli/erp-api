import { z } from 'zod';
import type { PrismaService } from '../../../database/prisma.service';
import { Prisma } from '../../../generated/prisma/client';
import { MAX_TOOL_ROWS } from './tool';
import type { AiTool } from './tool';

/** Customers as the customer screens show them (`customer.read`); revenue only with `payment.read`. */
export function customerTools(prisma: PrismaService): AiTool<unknown>[] {
  const findCustomers: AiTool<{ name: string }> = {
    name: 'find_customers',
    description: 'Find customers whose name contains the text, at most 25.',
    permissions: ['customer.read'],
    input: z.strictObject({ name: z.string().min(1).max(100) }),
    run: (ctx, input) =>
      prisma.inTenant(ctx.tenantId, async (tx) => {
        const rows = await tx.customer.findMany({
          where: { name: { contains: input.name, mode: 'insensitive' } },
          orderBy: { name: 'asc' },
          take: MAX_TOOL_ROWS,
          select: { id: true, name: true, status: true },
        });
        return { data: rows, refs: rows.map((row) => ({ type: 'customer' as const, id: row.id })) };
      }),
  };

  const getCustomer: AiTool<{ id: string }> = {
    name: 'get_customer',
    description: 'One customer by id: its status, when it joined, its orders and when it last ordered.',
    permissions: ['customer.read'],
    input: z.strictObject({ id: z.uuid() }),
    run: (ctx, input) =>
      prisma.inTenant(ctx.tenantId, async (tx) => {
        const customer = await tx.customer.findUnique({ where: { id: input.id }, select: { id: true, name: true, status: true, createdAt: true } });
        if (!customer) return { data: null, refs: [] };
        const orders = await tx.order.findMany({
          where: { customerId: customer.id, cancelledAt: null },
          select: { placedAt: true, total: true, taxAmount: true, currency: true },
          orderBy: { placedAt: 'desc' },
        });
        const revenue = new Map<string, Prisma.Decimal>();
        for (const order of orders) {
          revenue.set(order.currency, (revenue.get(order.currency) ?? new Prisma.Decimal(0)).add(order.total.sub(order.taxAmount)));
        }
        return {
          data: {
            id: customer.id,
            name: customer.name,
            status: customer.status,
            joined_on: customer.createdAt.toISOString().slice(0, 10),
            orders: orders.length,
            last_order_on: orders[0]?.placedAt.toISOString().slice(0, 10) ?? null,
            ...(ctx.permissions.has('payment.read')
              ? { revenue_net_of_tax: [...revenue].map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`) }
              : {}),
          },
          refs: [{ type: 'customer' as const, id: customer.id }],
        };
      }),
  };

  return [findCustomers, getCustomer] as AiTool<unknown>[];
}
