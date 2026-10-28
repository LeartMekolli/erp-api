import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { InvoicesService } from './invoices.service';

interface InvoicePayload {
  tenantId: string;
  orderId: string;
}

/** Invoices one shipped pay-later order (Payments spec); safe to run again. */
@Injectable()
@HandlesJob('payments.invoice.create')
export class InvoiceHandler implements JobHandler<InvoicePayload> {
  constructor(private readonly invoices: InvoicesService) {}

  handle({ tenantId, orderId }: InvoicePayload): Promise<void> {
    return this.invoices.create(tenantId, orderId);
  }
}
