import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import type { JobPayload } from '../../jobs/registry';
import { ProgressEmailsService } from './progress-emails.service';

const DAY_MS = 86_400_000;

/** After each move (JOBS['orders.progress']): the progress emails due for the groups it touched. */
@Injectable()
@HandlesJob('orders.progress')
export class ProgressEmailsHandler implements JobHandler<JobPayload<'orders.progress'>> {
  constructor(private readonly progress: ProgressEmailsService) {}

  async handle(payload: JobPayload<'orders.progress'>): Promise<void> {
    await this.progress.sendDue(payload.tenantId, payload.groupIds);
  }
}

/**
 * Every 15 minutes (SCHEDULED_JOBS['orders.progress.sweep']): the emails a lost job would have sent, for
 * groups moved in the last 24 hours in each active workspace. Safe to run again: each email is recorded
 * once per order and step name.
 */
@Injectable()
@HandlesJob('orders.progress.sweep')
export class ProgressEmailsSweepHandler implements JobHandler<Record<string, never>> {
  private readonly logger = new Logger(ProgressEmailsSweepHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly progress: ProgressEmailsService,
  ) {}

  async handle(): Promise<void> {
    const since = new Date(Date.now() - DAY_MS);
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const tenant of tenants) {
      // One workspace failing must not keep the others waiting.
      try {
        await this.progress.sendDue(tenant.id, await this.progress.recentlyMoved(tenant.id, since));
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'sending due progress emails failed');
      }
    }
  }
}
