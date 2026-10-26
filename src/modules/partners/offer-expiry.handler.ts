import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { HandlesJob, JobHandler } from '../../jobs/handles-job';
import { JobsService } from './jobs.service';

/**
 * Every minute (SCHEDULED_JOBS['partners.offers.expire']). Marks offers past their deadline expired,
 * audited, and tells staff the job needs a partner again (Partners spec, goal 10). Accepting refuses an
 * offer past its deadline, and a lapsed offer holds no room and blocks no new offer, so a late run never
 * changes an outcome. Safe to run again, and alongside a new offer of the job: an offer is expired
 * once, by a conditional update.
 */
@Injectable()
@HandlesJob('partners.offers.expire')
export class OfferExpiryHandler implements JobHandler<Record<string, never>> {
  private readonly logger = new Logger(OfferExpiryHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  async handle(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const tenant of tenants) {
      // One workspace failing must not keep the others' offers open.
      try {
        const expired = await this.prisma.inTenant(tenant.id, (tx) => this.jobs.expireLapsed(tx, { type: 'system' }));
        await this.jobs.notifyExpired(tenant.id, expired);
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'expiring partner offers failed for a workspace');
      }
    }
  }
}
