import type { INestApplication } from '@nestjs/common';
import type request from 'supertest';
import type { PrismaService } from '../src/database/prisma.service';
import { OrderStatesService } from '../src/modules/orders/order-states.service';

/**
 * For every order of the workspace: the stored state and payment state equal what the facts give
 * (`OrderStatesService.derive`), and `GET /orders/:id`, asked by `staff`, shows the stored values
 * (Orders list spec, Anti-goals).
 */
export async function expectStoredStates(
  prisma: PrismaService,
  app: INestApplication,
  tenantId: string,
  staff: { get: (path: string) => request.Test },
): Promise<void> {
  const states = app.get(OrderStatesService);
  const { stored, derived } = await prisma.inTenant(tenantId, async (tx) => {
    const orders = await tx.order.findMany({ orderBy: { id: 'asc' } });
    const fresh = await states.derive(tx, orders, await states.today(tx, tenantId));
    return {
      stored: orders.map((order) => ({ id: order.id, state: order.state, paymentState: order.paymentState })),
      derived: orders.map((order) => ({ id: order.id, ...fresh.get(order.id)! })),
    };
  });
  expect(stored).toEqual(derived);
  for (const order of stored) {
    const shown = (await staff.get(`/orders/${order.id}`).expect(200)).body as { state: string; payment: { state: string } };
    expect({ id: order.id, state: shown.state, paymentState: shown.payment.state }).toEqual(order);
  }
}
