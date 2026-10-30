import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { BriefingService } from './briefing.service';

/**
 * Every 15 minutes (SCHEDULED_JOBS['ai.briefing']). Queues one briefing run for each workspace whose
 * morning briefing is due; a second run finds it no longer due. Off with `AI_BRIEFINGS=false`.
 */
@Injectable()
@HandlesJob('ai.briefing')
export class BriefingHandler implements JobHandler<Record<string, never>> {
  constructor(
    private readonly briefings: BriefingService,
    private readonly config: ConfigService,
  ) {}

  async handle(): Promise<void> {
    if (!this.config.get('AI_BRIEFINGS')) return;
    await this.briefings.queueDue(new Date());
  }
}
