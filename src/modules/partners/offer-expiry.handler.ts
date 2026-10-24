import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { HandlesJob, JobHandler } from '../../jobs/handles-job';
import { NotificationsService } from '../notifications/notifications.service';
import { jobLabel } from './jobs.service';
import type { JobLabel } from './jobs.service';

/**
 * Every minute (SCHEDULED_JOBS['partners.offers.expire']). Marks offers past their deadline expired,
 * which frees the partner's room, and tells staff the job needs a partner again (Partners spec, goal
 * 10). Accepting already refuses an offer past its deadline, so a late run never lets one through.
 * Safe to run again: an offer is expired once, by a conditional update.
 */
@Injectable()
@HandlesJob('partners.offers.expire')
export class OfferExpiryHandler implements JobHandler<Record<string, never>> {
  private readonly logger = new Logger(OfferExpiryHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async handle(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const tenant of tenants) {
      // One workspace failing must not keep the others' offers open.
      try {
        const expired = await this.prisma.inTenant(tenant.id, async (tx) => {
          const now = new Date();
          const due = await tx.jobAssignment.findMany({
            where: { status: 'offered', expiresAt: { lte: now } },
            include: { partner: { select: { name: true } } },
          });
          const done: { id: string; partnerName: string; job: JobLabel }[] = [];
          for (const row of due) {
            const claimed = await tx.jobAssignment.updateMany({
              where: { id: row.id, status: 'offered' },
              data: { status: 'expired' },
            });
            if (claimed.count === 1) {
              done.push({ id: row.id, partnerName: row.partner.name, job: await jobLabel(tx, row.groupId) });
            }
          }
          return done;
        });

        for (const offer of expired) {
          await this.notifications.raise(tenant.id, 'partner.job.expired', { type: 'job_assignment', id: offer.id }, {
            partner_name: offer.partnerName,
            product_name: offer.job.productName,
            quantity: String(offer.job.quantity),
          });
        }
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'expiring partner offers failed for a workspace');
      }
    }
  }
}
