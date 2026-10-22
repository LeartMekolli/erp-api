import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ConfigService } from '../../config/config.service';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import {
  addVersionResponseSchema,
  downloadUrlResponseSchema,
  fileDetailResponseSchema,
  startUploadResponseSchema,
  versionResponseSchema,
} from './file-response';
import type { FileResponse, MeasureResponse, UploadResponse, VersionResponse } from './file-response';
import { DECLARED_UNITS, FILE_KINDS, FilesService } from './files.service';

// RFC 6838 type and subtype names, no parameters. Lowercased first (plan
// ruling), so the stored type, the signed header and later checks all agree.
const RESTRICTED_NAME = '[a-z0-9][a-z0-9!#$&^_.+-]{0,126}';
const contentTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(new RegExp(`^${RESTRICTED_NAME}/${RESTRICTED_NAME}$`), 'must be a type/subtype');

const nameSchema = z.string().trim().min(1).max(255);

const idSchema = z.uuid();

/** The size limit is configuration (FILE_MAX_BYTES), so the body schemas are built per instance. */
export function uploadSchemas(maxBytes: number) {
  const version = z.object({
    name: nameSchema,
    content_type: contentTypeSchema,
    size: z.number().int().min(1).max(maxBytes),
  });
  const file = version.extend({
    kind: z.enum(FILE_KINDS),
    declared_unit: z.enum(DECLARED_UNITS).optional(),
  });
  return { file, version };
}

type UploadSchemas = ReturnType<typeof uploadSchemas>;

@Controller('files')
export class FilesController {
  private readonly schemas: UploadSchemas;

  constructor(
    private readonly files: FilesService,
    config: ConfigService,
  ) {
    this.schemas = uploadSchemas(config.get('FILE_MAX_BYTES'));
  }

  @ApiDoc({
    summary: 'Start an upload: create a file and its first version, and get a signed upload link.',
    description:
      'PUT the bytes to `upload.url` with exactly `upload.headers`, before `upload.expires_at`; storage refuses ' +
      'another size or content type. Then call complete. The upload itself does not go through the API.',
    body: ({ fileMaxBytes }) => uploadSchemas(fileMaxBytes).file,
    response: startUploadResponseSchema,
    errors: [400, 401, 403],
  })
  @RequirePermission('file.write')
  @Post()
  start(
    @CurrentUser() auth: TenantAuth,
    @Body() body: unknown,
  ): Promise<{ file: FileResponse; version: VersionResponse; upload: UploadResponse }> {
    const input = this.schemas.file.parse(body);
    return this.files.start(auth, {
      kind: input.kind,
      name: input.name,
      contentType: input.content_type,
      size: input.size,
      declaredUnit: input.declared_unit,
    });
  }

  @ApiDoc({
    summary: 'Add a new version to a file, and get a signed upload link for it.',
    description: 'Upload and complete it as for a new file.',
    body: ({ fileMaxBytes }) => uploadSchemas(fileMaxBytes).version,
    response: addVersionResponseSchema,
    errors: [400, 401, 403, 404],
  })
  @RequirePermission('file.write')
  @Post(':id/versions')
  addVersion(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body() body: unknown,
  ): Promise<{ version: VersionResponse; upload: UploadResponse }> {
    const input = this.schemas.version.parse(body);
    return this.files.addVersion(auth, id, {
      name: input.name,
      contentType: input.content_type,
      size: input.size,
    });
  }

  @ApiDoc({
    summary: 'A file with all its versions and their measures, newest version first.',
    response: fileDetailResponseSchema,
    errors: [400, 401, 403, 404],
  })
  @RequirePermission('file.read')
  @Get(':id')
  get(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ): Promise<FileResponse & { versions: (VersionResponse & { measures: MeasureResponse[] })[] }> {
    return this.files.get(tenantId, id);
  }

  @ApiDoc({
    summary: 'Complete an upload once the bytes are in storage.',
    description:
      'Checks the stored object against the declared size and type, then queues the measuring. A mismatch, or an ' +
      'upload that is missing, is a 409.',
    response: versionResponseSchema,
    errors: [400, 401, 403, 404, 409],
  })
  @RequirePermission('file.write')
  @Post(':id/versions/:versionId/complete')
  @HttpCode(200)
  complete(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Param('versionId', new ZodValidationPipe(idSchema)) versionId: string,
  ): Promise<VersionResponse> {
    return this.files.complete(tenantId, id, versionId);
  }

  @ApiDoc({
    summary: 'A short-lived download link for a completed version.',
    description: 'A version that is not completed yet is a 409.',
    response: downloadUrlResponseSchema,
    errors: [400, 401, 403, 404, 409],
  })
  @RequirePermission('file.read')
  @Get(':id/versions/:versionId/url')
  downloadUrl(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Param('versionId', new ZodValidationPipe(idSchema)) versionId: string,
  ): Promise<{ url: string; expires_at: string }> {
    return this.files.downloadUrl(tenantId, id, versionId);
  }
}
