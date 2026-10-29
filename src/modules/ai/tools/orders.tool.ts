import { z } from 'zod';
import type { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { localDate } from '../../orders/dates';
import { ORDER_STATES } from '../../orders/order-response';
import { lineState, orderState } from '../../orders/order-state';
import type { OrderState } from '../../orders/order-state';
import { MAX_TOOL_ROWS } from './tool';
import type { AiTool } from './tool';

const DONE: OrderState[] = ['ready', 'shipped', 'delivered', 'cancelled'];
/** How many recent orders a search looks through before filtering by state. */
const SEARCHED = 500;

const ORDER_FIELDS = {
  id: true,
  number: true,
  promisedOn: true,
  placedAt: true,
  total: true,
  currency: true,
  shippedAt: true,
  deliveredAt: true,
  productionStartedAt: true,
  customer: { select: { id: true, name: true } },
  lines: {
    orderBy: { position: 'asc' },
    select: {
      quantity: true,
      cancelledAt: true,
      product: { select: { name: true } },
      group: { select: { workOrders: { select: { status: true } } } },
    },
  },
} as const satisfies Prisma.OrderSelect;

type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_FIELDS }>;

function view(order: OrderRow, today: string) {
  const lines = order.lines.map((line) => lineState(line.group?.workOrders ?? [], line.cancelledAt));
  const state = orderState(lines, order.shippedAt, order.deliveredAt, order.productionStartedAt);
  const promisedOn = order.promisedOn.toISOString().slice(0, 10);
  return {
    id: order.id,
    number: order.number,
    customer: order.customer,
    state,
    promised_on: promisedOn,
    placed_at: order.placedAt.toISOString(),
    late: promisedOn < today && !DONE.includes(state),
    total: `${order.total.toFixed(2)} ${order.currency}`,
    lines: order.lines.map((line, index) => ({ product: line.product.name, quantity: line.quantity, state: lines[index] })),
  };
}

async function today(tx: Prisma.TransactionClient, tenantId: string): Promise<string> {
  const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
  return localDate(new Date(), timezone);
}

/** Orders as the order screens show them (`order.read`). */
export function orderTools(prisma: PrismaService): AiTool<unknown>[] {
  const findOrders: AiTool<{ number?: number; customer_id?: string; state?: OrderState; late?: boolean }> = {
    name: 'find_orders',
    description:
      'Find orders, newest first, at most 25: by number, by customer id, by state, or only late ones (promised date ' +
      'passed and not ready, shipped, delivered or cancelled).',
    permissions: ['order.read'],
    input: z.strictObject({
      number: z.number().int().positive().optional(),
      customer_id: z.uuid().optional(),
      state: z.enum(ORDER_STATES).optional(),
      late: z.boolean().optional(),
    }),
    run: (ctx, input) =>
      prisma.inTenant(ctx.tenantId, async (tx) => {
        const day = await today(tx, ctx.tenantId);
        const rows = await tx.order.findMany({
          where: { number: input.number, customerId: input.customer_id },
          orderBy: { id: 'desc' },
          take: SEARCHED,
          select: ORDER_FIELDS,
        });
        const orders = rows
          .map((row) => view(row, day))
          .filter((order) => (input.state ? order.state === input.state : true) && (input.late ? order.late : true))
          .slice(0, MAX_TOOL_ROWS);
        return { data: orders, refs: orders.map((order) => ({ type: 'order' as const, id: order.id })) };
      }),
  };

  const getOrder: AiTool<{ id: string }> = {
    name: 'get_order',
    description: 'One order by id, with its lines and their states.',
    permissions: ['order.read'],
    input: z.strictObject({ id: z.uuid() }),
    run: (ctx, input) =>
      prisma.inTenant(ctx.tenantId, async (tx) => {
        const row = await tx.order.findUnique({ where: { id: input.id }, select: ORDER_FIELDS });
        if (!row) return { data: null, refs: [] };
        return { data: view(row, await today(tx, ctx.tenantId)), refs: [{ type: 'order' as const, id: row.id }] };
      }),
  };

  return [findOrders, getOrder] as AiTool<unknown>[];
}
