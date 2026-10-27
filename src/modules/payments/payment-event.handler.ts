import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { PaymentEventsService } from './payment-events.service';

interface PaymentEventPayload {
  tenantId: string;
  eventId: string;
}

/** Applies one stored webhook event (Payments spec, goal 10). */
@Injectable()
@HandlesJob('payments.event')
export class PaymentEventHandler implements JobHandler<PaymentEventPayload> {
  constructor(private readonly events: PaymentEventsService) {}

  handle({ tenantId, eventId }: PaymentEventPayload): Promise<void> {
    return this.events.apply(tenantId, eventId);
  }
}
