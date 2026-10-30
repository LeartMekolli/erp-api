import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema } from '../../../common/pagination/page';
import type { Page } from '../../../common/pagination/page';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentUser } from '../../identity/auth-context';
import type { TenantAuth } from '../../identity/auth-context';
import { RequirePermission } from '../../identity/route-markers';
import { exportRequestSchema } from './export-kinds';
import type { ExportRequest } from './export-kinds';
import { exportDownloadSchema, exportListQuerySchema, exportResponseSchema, exportStartedSchema } from './export-response';
import type { ExportDownload, ExportListQuery, ExportResponse } from './export-response';
import { ExportsService } from './exports.service';

const idParam = new ZodValidationPipe(z.uuid());

/** Exports of data as files (Reporting 2 spec): asked for, built in the background, downloaded by the asker. */
@Controller('reports/exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @ApiDoc({
    summary: 'Ask for an export of data as a CSV or PDF file, built in the background.',
    description:
      'Answers 202 with the export id; you are told in the feed when it is ready, then download it within 30 days. ' +
      "Each kind also needs the permission of the screen its data comes from (403 without it). The file holds only what you may " +
      'see now: columns needing a permission you lack are left out.',
    body: exportRequestSchema,
    response: exportStartedSchema,
    errors: [400],
  })
  @RequirePermission('report.export')
  @Post()
  @HttpCode(202)
  start(@CurrentUser() auth: TenantAuth, @Body(new ZodValidationPipe(exportRequestSchema)) body: ExportRequest): Promise<{ id: string }> {
    return this.exports.start(auth, body);
  }

  @ApiDoc({
    summary: 'Your exports, newest first.',
    description: 'Pass `next_cursor` back as `cursor` for the next page.',
    query: exportListQuerySchema,
    response: pageSchema(exportResponseSchema),
    errors: [400],
  })
  @RequirePermission('report.export')
  @Get()
  list(@CurrentUser() auth: TenantAuth, @Query(new ZodValidationPipe(exportListQuerySchema)) query: ExportListQuery): Promise<Page<ExportResponse>> {
    return this.exports.list(auth, query);
  }

  @ApiDoc({
    summary: 'One of your exports, with its status.',
    description: "Another person's export is a 404.",
    response: exportResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('report.export')
  @Get(':id')
  get(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<ExportResponse> {
    return this.exports.get(auth, id);
  }

  @ApiDoc({
    summary: 'A short-lived download link for one of your exports.',
    description: "409 until it is ready, or once it has expired. Another person's export is a 404.",
    response: exportDownloadSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('report.export')
  @Post(':id/download')
  @HttpCode(200)
  download(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<ExportDownload> {
    return this.exports.downloadUrl(auth, id);
  }
}
