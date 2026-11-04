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
import { PHOTO_CONTENT_TYPES, uploadSchemas } from '../files/files.controller';
import { FilesService } from '../files/files.service';
import type { FileOwner } from '../files/files.service';
import { CurrentPartner } from '../identity/auth-context';
import type { PartnerAuth } from '../identity/auth-context';
import { PartnerAccess } from '../identity/route-markers';

const idParam = new ZodValidationPipe(z.uuid());

const ownerOf = (partner: PartnerAuth): FileOwner => ({ type: 'partner', id: partner.partnerId });

const PHOTO_TYPES = PHOTO_CONTENT_TYPES.map((type) => `\`${type}\``).join(', ');

/**
 * The partner's own files: the QC photos its moves need. Every partner person may upload them, also
 * while the partner is suspended, so it can finish the jobs it holds. The staff file routes, limited
 * to files the partner owns; any other file is not found. Staff see these files too.
 */
@Controller('partner-portal/partners/:partnerId/files')
export class PartnerFilesController {
  private readonly schemas: ReturnType<typeof uploadSchemas>;

  constructor(
    private readonly files: FilesService,
    config: ConfigService,
  ) {
    this.schemas = uploadSchemas(config.get('FILE_MAX_BYTES'));
  }

  @ApiDoc({
    summary: 'Start an upload of a photo the partner owns, and get a signed upload link.',
    description:
      `Only images: ${PHOTO_TYPES}; the file's kind is always \`image\`. ` +
      'PUT the bytes to `upload.url` with exactly `upload.headers`, before `upload.expires_at`, then call complete. ' +
      "Attach the completed version to a move with `photo_file_version_ids`. A suspended partner can still upload, so it can finish its jobs.",
    body: ({ fileMaxBytes }) => uploadSchemas(fileMaxBytes).photo,
    response: startUploadResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member', { whileSuspended: true })
  @Post()
  start(
    @CurrentPartner() partner: PartnerAuth,
    @Body() body: unknown,
  ): Promise<{ file: FileResponse; version: VersionResponse; upload: UploadResponse }> {
    const input = this.schemas.photo.parse(body);
    return this.files.start(
      partner,
      { kind: 'image', name: input.name, contentType: input.content_type, size: input.size },
      ownerOf(partner),
    );
  }

  @ApiDoc({
    summary: "The partner's files, newest first.",
    query: paginationQuerySchema,
    response: pageSchema(fileResponseSchema),
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get()
  list(
    @CurrentPartner() partner: PartnerAuth,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: z.infer<typeof paginationQuerySchema>,
  ): Promise<Page<FileResponse>> {
    return this.files.list(partner.tenantId, ownerOf(partner), query);
  }

  @ApiDoc({
    summary: "Add a new version to one of the partner's files, and get a signed upload link for it.",
    description: `Only images: ${PHOTO_TYPES}.`,
    body: ({ fileMaxBytes }) => uploadSchemas(fileMaxBytes).photo,
    response: addVersionResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member', { whileSuspended: true })
  @Post(':id/versions')
  addVersion(
    @CurrentPartner() partner: PartnerAuth,
    @Param('id', idParam) id: string,
    @Body() body: unknown,
  ): Promise<{ version: VersionResponse; upload: UploadResponse }> {
    const input = this.schemas.photo.parse(body);
    return this.files.addVersion(
      partner,
      id,
      { name: input.name, contentType: input.content_type, size: input.size },
      ownerOf(partner),
    );
  }

  @ApiDoc({
    summary: "One of the partner's files, with all its versions, newest version first.",
    response: fileDetailResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get(':id')
  get(
    @CurrentPartner() partner: PartnerAuth,
    @Param('id', idParam) id: string,
  ): Promise<FileResponse & { versions: (VersionResponse & { measures: MeasureResponse[] })[] }> {
    return this.files.get(partner.tenantId, id, ownerOf(partner));
  }

  @ApiDoc({
    summary: 'Complete an upload once the bytes are in storage.',
    description: 'A mismatch with what was declared, or an upload that is missing, is a 409.',
    response: versionResponseSchema,
    errors: [400, 404, 409],
  })
  @PartnerAccess('member', { whileSuspended: true })
  @Post(':id/versions/:versionId/complete')
  @HttpCode(200)
  complete(
    @CurrentPartner() partner: PartnerAuth,
    @Param('id', idParam) id: string,
    @Param('versionId', idParam) versionId: string,
  ): Promise<VersionResponse> {
    return this.files.complete(partner.tenantId, id, versionId, ownerOf(partner));
  }

  @ApiDoc({
    summary: "A short-lived download link for a completed version of one of the partner's files.",
    response: downloadUrlResponseSchema,
    errors: [400, 404, 409],
  })
  @PartnerAccess('member')
  @Get(':id/versions/:versionId/url')
  downloadUrl(
    @CurrentPartner() partner: PartnerAuth,
    @Param('id', idParam) id: string,
    @Param('versionId', idParam) versionId: string,
  ): Promise<{ url: string; expires_at: string }> {
    return this.files.downloadUrl(partner.tenantId, id, versionId, ownerOf(partner));
  }
}
