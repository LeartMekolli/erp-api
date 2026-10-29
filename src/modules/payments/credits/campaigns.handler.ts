import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../../jobs/handles-job';
import type { JobHandler } from '../../../jobs/handles-job';
import { CampaignsService } from './campaigns.service';

/**
 * Every 5 minutes (SCHEDULED_JOBS['payments.campaigns.grant']). Grants running campaigns to the
 * customers they target and haven't reached yet: a campaign that starts later, a customer named after
 * activation, or a grant a failed step missed. Each customer gets a campaign's credits once.
 */
@Injectable()
@HandlesJob('payments.campaigns.grant')
export class CampaignsHandler implements JobHandler<Record<string, never>> {
  constructor(private readonly campaigns: CampaignsService) {}

  handle(): Promise<void> {
    return this.campaigns.runEverywhere();
  }
}
