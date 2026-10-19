import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { newId } from '../../common/ids/uuid';
import { PrismaService } from '../../database/prisma.service';
import { JobsService } from '../../jobs/jobs.service';
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
const DOWNLOAD_EXPIRES_SECONDS = 5 * 60;

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
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
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

  /**
   * Checks the stored object against the declaration (plan S5) and hands the
   * version to the measurement job. Completing again is a no-op that returns
   * the version as it is now.
   */
  async complete(tenantId: string, fileId: string, versionId: string): Promise<VersionResponse> {
    const version = await this.findVersion(tenantId, fileId, versionId);
    if (version.status !== 'pending') {
      return toVersionResponse(version);
    }

    const stored = await this.storage.head(version.storageKey);
    if (!stored) {
      throw new ConflictException('Upload not found');
    }
    if (stored.size !== Number(version.size) || stored.contentType.toLowerCase() !== version.contentType) {
      throw new ConflictException('Upload does not match what was declared');
    }

    const { won, current } = await this.prisma.inTenant(tenantId, async (tx) => {
      const { count } = await tx.fileVersion.updateMany({
        where: { id: versionId, status: 'pending' },
        data: { status: 'uploaded', completedAt: new Date() },
      });
      return { won: count === 1, current: await tx.fileVersion.findUniqueOrThrow({ where: { id: versionId } }) };
    });

    // After the commit, so the job never finds the version still pending. Only
    // the request that moved it enqueues; a lost enqueue is recovered by the
    // claim sweeper a minute after completion.
    if (won) {
      try {
        await this.jobs.enqueue('file.measure', { tenantId, fileId, versionId });
      } catch (error) {
        this.logger.warn(
          `Could not enqueue measurement of version ${versionId}; the sweeper will: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return toVersionResponse(current);
  }

  /** A short-lived GET (plan S4, S8), once the upload has been completed. */
  async downloadUrl(tenantId: string, fileId: string, versionId: string): Promise<{ url: string; expires_at: string }> {
    const version = await this.findVersion(tenantId, fileId, versionId);
    if (version.status === 'pending') {
      throw new ConflictException('Upload not completed');
    }

    const expiresAt = new Date(Date.now() + DOWNLOAD_EXPIRES_SECONDS * 1000);
    const url = await this.storage.presignGet(version.storageKey, {
      fileName: version.originalName,
      contentType: version.contentType,
      expiresInSeconds: DOWNLOAD_EXPIRES_SECONDS,
    });
    return { url, expires_at: expiresAt.toISOString() };
  }

  /** The version, only under its own file and only in this tenant (RLS); 404 otherwise. */
  private async findVersion(tenantId: string, fileId: string, versionId: string) {
    const version = await this.prisma.inTenant(tenantId, (tx) =>
      tx.fileVersion.findFirst({ where: { id: versionId, fileId } }),
    );
    if (!version) {
      throw new NotFoundException('File version not found');
    }
    return version;
  }

  private keyFor(tenantId: string, fileId: string, versionId: string): string {
    return `${tenantId}/${fileId}/${versionId}`;
  }

  private async signUpload(key: string, input: NewUpload): Promise<UploadResponse> {
    const expiresAt = new Date(Date.now() + UPLOAD_EXPIRES_SECONDS * 1000);
    const { url, headers } = await this.storage.presignPut(key, {
      contentType: input.contentType,
      contentLength: input.size,
      expiresInSeconds: UPLOAD_EXPIRES_SECONDS,
    });
    return { url, method: 'PUT', headers, expires_at: expiresAt.toISOString() };
  }
}
