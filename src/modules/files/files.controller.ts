import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ConfigService } from '../../config/config.service';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
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
function uploadSchemas(maxBytes: number) {
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

  @RequirePermission('file.read')
  @Get(':id')
  get(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ): Promise<FileResponse & { versions: (VersionResponse & { measures: MeasureResponse[] })[] }> {
    return this.files.get(tenantId, id);
  }
}
