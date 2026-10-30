import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { CustomerToolsService } from './customer-tools/customer-tools.service';

interface GiveBackPayload {
  tenantId: string;
  runId: string;
}

/** Gives a failed customer run's credits back (JOBS['ai.credits.give_back']); a retry gives nothing twice. */
@Injectable()
@HandlesJob('ai.credits.give_back')
export class GiveBackHandler implements JobHandler<GiveBackPayload> {
  constructor(private readonly tools: CustomerToolsService) {}

  handle({ tenantId, runId }: GiveBackPayload): Promise<void> {
    return this.tools.giveBack(tenantId, runId);
  }
}

/**
 * Every 15 minutes (SCHEDULED_JOBS['ai.credits.sweep']). Gives back the credits of each failed customer
 * run whose give-back job was never queued or gave up.
 */
@Injectable()
@HandlesJob('ai.credits.sweep')
export class GiveBackSweepHandler implements JobHandler<Record<string, never>> {
  constructor(private readonly tools: CustomerToolsService) {}

  handle(): Promise<void> {
    return this.tools.giveBackDueEverywhere();
  }
}
