import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { PayoutsService } from './payouts.service';

interface PayoutPayload {
  tenantId: string;
  payoutId: string;
}

/** Makes one pending payout's transfer (Payments spec); safe to run again. */
@Injectable()
@HandlesJob('payments.payout.transfer')
export class PayoutHandler implements JobHandler<PayoutPayload> {
  constructor(private readonly payouts: PayoutsService) {}

  handle({ tenantId, payoutId }: PayoutPayload): Promise<void> {
    return this.payouts.transfer(tenantId, payoutId);
  }
}
