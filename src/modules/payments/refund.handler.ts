import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { RefundsService } from './refunds.service';

interface RefundPayload {
  tenantId: string;
  refundId: string;
}

/** Asks the provider for one pending refund (Payments spec); safe to run again. */
@Injectable()
@HandlesJob('payments.refund')
export class RefundHandler implements JobHandler<RefundPayload> {
  constructor(private readonly refunds: RefundsService) {}

  handle({ tenantId, refundId }: RefundPayload): Promise<void> {
    return this.refunds.process(tenantId, refundId);
  }
}
