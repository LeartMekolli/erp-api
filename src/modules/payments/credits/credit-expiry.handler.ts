import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../../jobs/handles-job';
import type { JobHandler } from '../../../jobs/handles-job';
import { CreditsService } from './credits.service';

/**
 * Every 15 minutes (SCHEDULED_JOBS['payments.credits.expire']). Writes off what is left of expired
 * grants. Spending never waits for it: a grant past its expiry is never spent, written off or not.
 */
@Injectable()
@HandlesJob('payments.credits.expire')
export class CreditExpiryHandler implements JobHandler<Record<string, never>> {
  constructor(private readonly credits: CreditsService) {}

  handle(): Promise<void> {
    return this.credits.expireDue();
  }
}
