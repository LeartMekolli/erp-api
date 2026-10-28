import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../../jobs/handles-job';
import type { JobHandler } from '../../../jobs/handles-job';
import { AllowancesService } from './allowances.service';

/**
 * Every 15 minutes (SCHEDULED_JOBS['payments.credits.allowances']). Grants each customer the month
 * it is owed: free-plan customers and yearly subscribers get their months here; a monthly
 * subscriber's comes with its paid invoice, and this only catches up a missed one.
 */
@Injectable()
@HandlesJob('payments.credits.allowances')
export class AllowancesHandler implements JobHandler<Record<string, never>> {
  constructor(private readonly allowances: AllowancesService) {}

  handle(): Promise<void> {
    return this.allowances.grantDueEverywhere(new Date());
  }
}
