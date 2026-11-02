import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../jobs/handles-job';
import type { JobHandler } from '../../jobs/handles-job';
import { CreditNotesService } from './credit-notes.service';

interface CreditNotePayload {
  tenantId: string;
  creditNoteId: string;
}

/** Asks the provider for one pending credit note (Orders 3 spec, goal 3); safe to run again. */
@Injectable()
@HandlesJob('payments.credit_note')
export class CreditNoteHandler implements JobHandler<CreditNotePayload> {
  constructor(private readonly creditNotes: CreditNotesService) {}

  handle({ tenantId, creditNoteId }: CreditNotePayload): Promise<void> {
    return this.creditNotes.process(tenantId, creditNoteId);
  }

  onDeadLetter({ tenantId, creditNoteId }: CreditNotePayload): Promise<void> {
    return this.creditNotes.failed(tenantId, creditNoteId);
  }
}
