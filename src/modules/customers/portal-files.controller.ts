import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ConfigService } from '../../config/config.service';
import { ApiDoc } from '../../docs/api-doc';
import {
  addVersionResponseSchema,
  downloadUrlResponseSchema,
  fileDetailResponseSchema,
  fileResponseSchema,
  startUploadResponseSchema,
  versionResponseSchema,
} from '../files/file-response';
import type { FileResponse, MeasureResponse, UploadResponse, VersionResponse } from '../files/file-response';
import { uploadSchemas } from '../files/files.controller';
import { FilesService } from '../files/files.service';
import type { FileOwner } from '../files/files.service';
import { CurrentCustomer } from '../identity/auth-context';
import type { CustomerAuth } from '../identity/auth-context';
import { CustomerAccess } from '../identity/route-markers';

const idParam = new ZodValidationPipe(z.uuid());

const ownerOf = (customer: CustomerAuth): FileOwner => ({ type: 'customer', id: customer.customerId });

/**
 * The customer's own files (Customers spec, goals 6 and 8): everyone at the
 * customer sees them, buyers and above upload. The staff file routes, limited
 * to files the customer owns; any other file is not found.
 */
@Controller('portal/customers/:customerId/files')
export class PortalFilesController {
  private readonly schemas: ReturnType<typeof uploadSchemas>;

  constructor(
    private readonly files: FilesService,
    config: ConfigService,
  ) {
    this.schemas = uploadSchemas(config.get('FILE_MAX_BYTES'));
  }

  @ApiDoc({
    summary: 'Start an upload of a file the customer owns, and get a signed upload link.',
    description:
      'PUT the bytes to `upload.url` with exactly `upload.headers`, before `upload.expires_at`, then call complete. ' +
      'A design file is measured once completed.',
    body: ({ fileMaxBytes }) => uploadSchemas(fileMaxBytes).file,
    response: startUploadResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('buyer')
  @Post()
  start(
    @CurrentCustomer() customer: CustomerAuth,
    @Body() body: unknown,
  ): Promise<{ file: FileResponse; version: VersionResponse; upload: UploadResponse }> {
    const input = this.schemas.file.parse(body);
    return this.files.start(
      customer,
      {
        kind: input.kind,
        name: input.name,
        contentType: input.content_type,
        size: input.size,
        declaredUnit: input.declared_unit,
      },
      ownerOf(customer),
    );
  }

  @ApiDoc({
    summary: "The customer's files, newest first.",
    query: paginationQuerySchema,
    response: pageSchema(fileResponseSchema),
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get()
  list(
    @CurrentCustomer() customer: CustomerAuth,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: z.infer<typeof paginationQuerySchema>,
  ): Promise<Page<FileResponse>> {
    return this.files.list(customer.tenantId, ownerOf(customer), query);
  }

  @ApiDoc({
    summary: "Add a new version to one of the customer's files, and get a signed upload link for it.",
    body: ({ fileMaxBytes }) => uploadSchemas(fileMaxBytes).version,
    response: addVersionResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('buyer')
  @Post(':id/versions')
  addVersion(
    @CurrentCustomer() customer: CustomerAuth,
    @Param('id', idParam) id: string,
    @Body() body: unknown,
  ): Promise<{ version: VersionResponse; upload: UploadResponse }> {
    const input = this.schemas.version.parse(body);
    return this.files.addVersion(
      customer,
      id,
      { name: input.name, contentType: input.content_type, size: input.size },
      ownerOf(customer),
    );
  }

  @ApiDoc({
    summary: "One of the customer's files, with all its versions and their measures, newest version first.",
    response: fileDetailResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get(':id')
  get(
    @CurrentCustomer() customer: CustomerAuth,
    @Param('id', idParam) id: string,
  ): Promise<FileResponse & { versions: (VersionResponse & { measures: MeasureResponse[] })[] }> {
    return this.files.get(customer.tenantId, id, ownerOf(customer));
  }

  @ApiDoc({
    summary: 'Complete an upload once the bytes are in storage.',
    description: 'A mismatch with what was declared, or an upload that is missing, is a 409.',
    response: versionResponseSchema,
    errors: [400, 404, 409],
  })
  @CustomerAccess('buyer')
  @Post(':id/versions/:versionId/complete')
  @HttpCode(200)
  complete(
    @CurrentCustomer() customer: CustomerAuth,
    @Param('id', idParam) id: string,
    @Param('versionId', idParam) versionId: string,
  ): Promise<VersionResponse> {
    return this.files.complete(customer.tenantId, id, versionId, ownerOf(customer));
  }

  @ApiDoc({
    summary: "A short-lived download link for a completed version of one of the customer's files.",
    response: downloadUrlResponseSchema,
    errors: [400, 404, 409],
  })
  @CustomerAccess('viewer')
  @Get(':id/versions/:versionId/url')
  downloadUrl(
    @CurrentCustomer() customer: CustomerAuth,
    @Param('id', idParam) id: string,
    @Param('versionId', idParam) versionId: string,
  ): Promise<{ url: string; expires_at: string }> {
    return this.files.downloadUrl(customer.tenantId, id, versionId, ownerOf(customer));
  }
}
