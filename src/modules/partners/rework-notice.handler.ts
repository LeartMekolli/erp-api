import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import type { JobPayload } from '../../jobs/registry';
import { ReworkNoticeService } from './rework-notice.service';

/** After each fail or correction (JOBS['partners.rework_notice']): tells partners whose finished pieces came back. */
@Injectable()
@HandlesJob('partners.rework_notice')
export class ReworkNoticeHandler implements JobHandler<JobPayload<'partners.rework_notice'>> {
  constructor(private readonly notices: ReworkNoticeService) {}

  async handle(payload: JobPayload<'partners.rework_notice'>): Promise<void> {
    await this.notices.notify(payload.tenantId, payload.moveId);
  }
}
