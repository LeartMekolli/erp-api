import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { OrderStatesService } from './order-states.service';

/**
 * Every hour (SCHEDULED_JOBS['orders.states.refresh']). Refreshes the stored states of each active
 * workspace's orders that time alone can still change, such as an invoice falling overdue, and fills
 * orders not computed yet.
 */
@Injectable()
@HandlesJob('orders.states.refresh')
export class OrderStatesHandler implements JobHandler<Record<string, never>> {
  private readonly logger = new Logger(OrderStatesHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly states: OrderStatesService,
  ) {}

  async handle(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const tenant of tenants) {
      // One workspace failing must not leave the others' orders behind.
      try {
        await this.states.refreshOpen(tenant.id);
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'refreshing stored order states failed for a workspace');
      }
    }
  }
}
