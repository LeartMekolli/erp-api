import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { CourierEventsService } from './courier-events.service';

interface CourierEventPayload {
  tenantId: string;
  eventId: string;
}

/** Applies one stored tracking event (Orders 3 spec, goal 24). */
@Injectable()
@HandlesJob('couriers.event')
export class CourierEventHandler implements JobHandler<CourierEventPayload> {
  constructor(private readonly events: CourierEventsService) {}

  handle({ tenantId, eventId }: CourierEventPayload): Promise<void> {
    return this.events.apply(tenantId, eventId);
  }
}
