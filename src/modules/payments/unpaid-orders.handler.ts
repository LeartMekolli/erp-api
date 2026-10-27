import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { HandlesJob, JobHandler } from '../../jobs/handles-job';
import { OrdersService } from '../orders/orders.service';

/**
 * Every minute (SCHEDULED_JOBS['payments.unpaid.cancel']). Cancels pay-first orders past their
 * `pay_by` that have not started and are not cancelled, as the system, which frees their workshop's
 * capacity and expires their checkout (Payments spec). Safe to run again: `cancelUnpaid` checks each
 * order again under its lock, so one paid or cancelled meanwhile is left as it is.
 */
@Injectable()
@HandlesJob('payments.unpaid.cancel')
export class UnpaidOrdersHandler implements JobHandler<Record<string, never>> {
  private readonly logger = new Logger(UnpaidOrdersHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  async handle(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const tenant of tenants) {
      const due = await this.prisma.inTenant(tenant.id, (tx) =>
        tx.order.findMany({
          where: { productionStartedAt: null, cancelledAt: null, payBy: { lte: new Date() } },
          select: { id: true },
          orderBy: { id: 'asc' },
        }),
      );
      for (const order of due) {
        // One order failing must not keep the others waiting.
        try {
          await this.orders.cancelUnpaid(tenant.id, order.id);
        } catch (error) {
          this.logger.error({ err: error, tenantId: tenant.id, orderId: order.id }, 'cancelling an unpaid order failed');
        }
      }
    }
  }
}
