import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { AuditInput } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { JobsService } from '../partners/jobs.service';

export interface Started {
  orderId: string;
  number: number;
  /** Jobs whose workshops are told of them once the transaction has committed. */
  handedOver: string[];
  /** Lines whose workshop was suspended while the order waited: in-house now. */
  lost: { position: number; partnerName: string }[];
}

/**
 * Starts a waiting order, once paid or released (Payments spec): Orders starts it, and Partners hands
 * the jobs its workshops held to them, or takes back those of a workshop suspended meanwhile.
 */
@Injectable()
export class OrderStarter {
  private readonly logger = new Logger(OrderStarter.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** In the caller's transaction. Null when the order has started already, or is cancelled. */
  async start(tx: Prisma.TransactionClient, tenantId: string, orderId: string, actor: AuditInput['actor']): Promise<Started | null> {
    const started = await this.orders.startProduction(tx, orderId, new Date(), actor);
    if (!started) return null;
    const jobs = await this.jobs.startHeldJobs(tx, tenantId, started.lines.flatMap((line) => line.groupIds), actor);
    return {
      orderId,
      number: started.number,
      handedOver: jobs.handedOver,
      lost: jobs.lost.map((job) => ({
        position: started.lines.find((line) => line.groupIds.includes(job.groupId))?.position ?? 0,
        partnerName: job.partnerName,
      })),
    };
  }

  /** After commit: each workshop hears of its job, and staff of each line that lost its workshop. A failure is logged. */
  async announce(tenantId: string, started: Started | null): Promise<void> {
    if (!started) return;
    try {
      await this.jobs.notifyDirect(tenantId, started.handedOver);
      for (const lost of started.lost) {
        await this.notifications.raise(tenantId, 'order.partner_lost', { type: 'order', id: started.orderId }, {
          number: String(started.number),
          line: String(lost.position + 1),
          partner_name: lost.partnerName,
        });
      }
    } catch (error) {
      this.logger.error({ err: error, tenantId, orderId: started.orderId }, 'telling of a started order failed');
    }
  }
}
