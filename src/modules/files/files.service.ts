import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../common/ids/uuid';
import { PrismaService } from '../../database/prisma.service';
import type { ObjectStorage } from '../../storage/object-storage';
import { STORAGE } from '../../storage/object-storage';
import type { TenantAuth } from '../identity/auth-context';
import { toFileResponse, toMeasureResponse, toVersionResponse } from './file-response';
import type { FileResponse, MeasureResponse, UploadResponse, VersionResponse } from './file-response';

/** Plan S7. Fixed in code; Catalog decides what each kind means for a product. */
export const FILE_KINDS = ['design', 'image', 'document', 'other'] as const;
export const DECLARED_UNITS = ['mm', 'cm', 'm', 'in'] as const;

export type FileKind = (typeof FILE_KINDS)[number];
export type DeclaredUnit = (typeof DECLARED_UNITS)[number];

/** Plan S4. */
const UPLOAD_EXPIRES_SECONDS = 15 * 60;

export interface NewUpload {
  name: string;
  contentType: string;
  size: number;
}

/**
 * The one file service (spec 5.4). The API never touches bytes: it records a
 * pending version, signs a PUT for exactly the declared size and type, and the
 * client uploads straight to storage. Keys are built from ids alone (plan S3).
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async start(
    auth: TenantAuth,
    input: NewUpload & { kind: FileKind; declaredUnit?: DeclaredUnit },
  ): Promise<{ file: FileResponse; version: VersionResponse; upload: UploadResponse }> {
    const fileId = newId();
    const versionId = newId();
    const storageKey = this.keyFor(auth.tenantId, fileId, versionId);

    const { file, version } = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const file = await tx.file.create({
        data: {
          id: fileId,
          kind: input.kind,
          name: input.name,
          declaredUnit: input.declaredUnit ?? null,
          createdByUserId: auth.userId,
        },
      });
      const version = await tx.fileVersion.create({
        data: {
          id: versionId,
          fileId,
          number: 1,
          storageKey,
          originalName: input.name,
          contentType: input.contentType,
          size: BigInt(input.size),
          uploadedByUserId: auth.userId,
        },
      });
      return { file, version };
    });

    return {
      file: toFileResponse(file),
      version: toVersionResponse(version),
      upload: await this.signUpload(storageKey, input),
    };
  }

  async addVersion(
    auth: TenantAuth,
    fileId: string,
    input: NewUpload,
  ): Promise<{ version: VersionResponse; upload: UploadResponse }> {
    const versionId = newId();
    const storageKey = this.keyFor(auth.tenantId, fileId, versionId);

    const version = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      // Locking the file serialises numbering: a concurrent request waits here
      // and then sees this version, so it takes the next number instead of failing.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM file WHERE id = ${fileId}::uuid FOR UPDATE`;
      if (locked.length === 0) {
        throw new NotFoundException('File not found');
      }
      const last = await tx.fileVersion.aggregate({ where: { fileId }, _max: { number: true } });

      return tx.fileVersion.create({
        data: {
          id: versionId,
          fileId,
          number: (last._max.number ?? 0) + 1,
          storageKey,
          originalName: input.name,
          contentType: input.contentType,
          size: BigInt(input.size),
          uploadedByUserId: auth.userId,
        },
      });
    });

    return { version: toVersionResponse(version), upload: await this.signUpload(storageKey, input) };
  }

  async get(
    tenantId: string,
    fileId: string,
  ): Promise<FileResponse & { versions: (VersionResponse & { measures: MeasureResponse[] })[] }> {
    const file = await this.prisma.inTenant(tenantId, (tx) =>
      tx.file.findUnique({
        where: { id: fileId },
        include: { versions: { orderBy: { number: 'desc' }, include: { measures: { orderBy: { type: 'asc' } } } } },
      }),
    );
    if (!file) {
      throw new NotFoundException('File not found');
    }

    return {
      ...toFileResponse(file),
      versions: file.versions.map((version) => ({
        ...toVersionResponse(version),
        measures: version.measures.map(toMeasureResponse),
      })),
    };
  }

  private keyFor(tenantId: string, fileId: string, versionId: string): string {
    return `${tenantId}/${fileId}/${versionId}`;
  }

  private async signUpload(key: string, input: NewUpload): Promise<UploadResponse> {
    const expiresAt = new Date(Date.now() + UPLOAD_EXPIRES_SECONDS * 1000);
    const url = await this.storage.presignPut(key, {
      contentType: input.contentType,
      contentLength: input.size,
      expiresInSeconds: UPLOAD_EXPIRES_SECONDS,
    });
    return {
      url,
      method: 'PUT',
      headers: { 'content-type': input.contentType, 'content-length': String(input.size) },
      expires_at: expiresAt.toISOString(),
    };
  }
}
