import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { PayoutsService } from './payouts.service';

/** Mondays (SCHEDULED_JOBS['payments.payouts.remind']): which partners have money due (Payments spec). */
@Injectable()
@HandlesJob('payments.payouts.remind')
export class PayoutReminderHandler implements JobHandler<Record<string, never>> {
  constructor(private readonly payouts: PayoutsService) {}

  handle(): Promise<void> {
    return this.payouts.remind();
  }
}
