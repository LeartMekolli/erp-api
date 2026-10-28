import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { InvoicesService } from './invoices.service';

/**
 * Daily (SCHEDULED_JOBS['payments.invoices.overdue']). Tells the customer and staff of each open
 * invoice past its due date, once (Payments spec). Safe to run again: a told invoice is marked.
 */
@Injectable()
@HandlesJob('payments.invoices.overdue')
export class OverdueInvoicesHandler implements JobHandler<Record<string, never>> {
  constructor(private readonly invoices: InvoicesService) {}

  handle(): Promise<void> {
    return this.invoices.notifyOverdue();
  }
}
