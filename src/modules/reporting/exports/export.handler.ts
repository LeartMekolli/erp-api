import { Injectable } from '@nestjs/common';
import { HandlesJob } from '../../../jobs/handles-job';
import type { JobHandler } from '../../../jobs/handles-job';
import { ExportsService } from './exports.service';

interface ExportPayload {
  tenantId: string;
  exportId: string;
}

/** Builds one export (JOBS['reports.export']); after the last attempt fails, the asker is told plainly. */
@Injectable()
@HandlesJob('reports.export')
export class ExportHandler implements JobHandler<ExportPayload> {
  constructor(private readonly exports: ExportsService) {}

  handle({ tenantId, exportId }: ExportPayload): Promise<void> {
    return this.exports.run(tenantId, exportId);
  }

  onDeadLetter({ tenantId, exportId }: ExportPayload): Promise<void> {
    return this.exports.failedPlainly(tenantId, exportId);
  }
}

/** Every hour (SCHEDULED_JOBS['reports.exports.expire']): removes the files of exports past 30 days. */
@Injectable()
@HandlesJob('reports.exports.expire')
export class ExpireExportsHandler implements JobHandler<Record<string, never>> {
  constructor(private readonly exports: ExportsService) {}

  handle(): Promise<void> {
    return this.exports.expireDue(new Date());
  }
}
