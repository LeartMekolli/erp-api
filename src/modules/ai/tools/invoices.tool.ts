import { z } from 'zod';
import type { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { localDate } from '../../orders/dates';
import { MAX_TOOL_ROWS } from './tool';
import type { AiTool } from './tool';

/** Invoices of pay-later orders (`payment.read`). */
export function invoiceTools(prisma: PrismaService): AiTool<unknown>[] {
  const listInvoices: AiTool<{ customer_id?: string; overdue?: boolean }> = {
    name: 'list_invoices',
    description: 'Invoices not paid yet, oldest due first, at most 25: of one customer, or only overdue ones.',
    permissions: ['payment.read'],
    input: z.strictObject({ customer_id: z.uuid().optional(), overdue: z.boolean().optional() }),
    run: (ctx, input) =>
      prisma.inTenant(ctx.tenantId, async (tx) => {
        const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { timezone: true } });
        const today = new Date(`${localDate(new Date(), timezone)}T00:00:00Z`);
        const where: Prisma.InvoiceWhereInput = {
          status: 'open',
          ...(input.customer_id ? { order: { customerId: input.customer_id } } : {}),
          ...(input.overdue ? { dueOn: { lt: today } } : {}),
        };
        const rows = await tx.invoice.findMany({
          where,
          orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
          take: MAX_TOOL_ROWS,
          select: {
            id: true,
            total: true,
            currency: true,
            dueOn: true,
            order: { select: { id: true, number: true, customer: { select: { id: true, name: true } } } },
          },
        });
        return {
          data: rows.map((row) => ({
            id: row.id,
            order: { id: row.order.id, number: row.order.number },
            customer: row.order.customer,
            total: `${row.total.toFixed(2)} ${row.currency}`,
            due_on: row.dueOn.toISOString().slice(0, 10),
            overdue: row.dueOn < today,
          })),
          refs: rows.map((row) => ({ type: 'invoice' as const, id: row.id })),
        };
      }),
  };

  return [listInvoices] as AiTool<unknown>[];
}
