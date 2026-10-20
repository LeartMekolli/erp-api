import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { newId } from '../../common/ids/uuid';
import { PrismaService } from '../../database/prisma.service';
import { ClaimSweeper } from '../../jobs/claim-sweeper';
import { claimRow, releaseRow } from '../../jobs/claims';
import { JobsService } from '../../jobs/jobs.service';
import type { ObjectStorage, StoredObject } from '../../storage/object-storage';
import { ObjectChangedError, ObjectNotFoundError, STORAGE } from '../../storage/object-storage';
import type { TenantAuth } from '../identity/auth-context';
import { toFileResponse, toMeasureResponse, toVersionResponse } from './file-response';
import type { FileResponse, MeasureResponse, UploadResponse, VersionResponse } from './file-response';
import { finalKeyFor, uploadKeyFor } from './storage-keys';

/** Plan S7. Fixed in code; Catalog decides what each kind means for a product. */
export const FILE_KINDS = ['design', 'image', 'document', 'other'] as const;
export const DECLARED_UNITS = ['mm', 'cm', 'm', 'in'] as const;

export type FileKind = (typeof FILE_KINDS)[number];
export type DeclaredUnit = (typeof DECLARED_UNITS)[number];

/** Plan S4. */
const UPLOAD_EXPIRES_SECONDS = 15 * 60;
const DOWNLOAD_EXPIRES_SECONDS = 5 * 60;
/** A completion that has not finished in 5 minutes is assumed dead and handed back. */
const COMPLETING_STALE_MS = 5 * 60 * 1000;
const MISMATCH = 'Upload does not match what was declared';

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
export class FilesService implements OnModuleInit {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly sweeper: ClaimSweeper,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** The completion claim has no job, so the sweeper only hands a dead one back. */
  onModuleInit(): void {
    this.sweeper.register({
      table: 'file_version',
      pending: 'pending',
      claimed: 'completing',
      staleAfterMs: COMPLETING_STALE_MS,
      recoverOnly: true,
    });
  }

  async start(
    auth: TenantAuth,
    input: NewUpload & { kind: FileKind; declaredUnit?: DeclaredUnit },
  ): Promise<{ file: FileResponse; version: VersionResponse; upload: UploadResponse }> {
    const fileId = newId();
    const versionId = newId();
    const storageKey = finalKeyFor(auth.tenantId, fileId, versionId);

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
      upload: await this.signUpload(uploadKeyFor(storageKey), input),
    };
  }

  async addVersion(
    auth: TenantAuth,
    fileId: string,
    input: NewUpload,
  ): Promise<{ version: VersionResponse; upload: UploadResponse }> {
    const versionId = newId();
    const storageKey = finalKeyFor(auth.tenantId, fileId, versionId);

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

    return { version: toVersionResponse(version), upload: await this.signUpload(uploadKeyFor(storageKey), input) };
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
   * Moves the checked object to the key no link can write, then hands the
   * version to the measurement job (plan S5, staging spec 2.6). Only the request
   * that wins the `completing` claim copies. Completing again, or while another
   * request holds the claim, returns the version as it is.
   */
  async complete(tenantId: string, fileId: string, versionId: string): Promise<VersionResponse> {
    const version = await this.findVersion(tenantId, fileId, versionId);
    if (version.status !== 'pending') {
      return toVersionResponse(version);
    }

    const uploadKey = uploadKeyFor(version.storageKey);
    const uploaded = await this.storage.head(uploadKey);
    if (!uploaded) {
      // A concurrent request may have completed it meanwhile and deleted the upload key.
      const current = await this.findVersion(tenantId, fileId, versionId);
      if (current.status !== 'pending') {
        return toVersionResponse(current);
      }
      throw new ConflictException('Upload not found');
    }
    if (!this.matchesDeclaration(uploaded, version)) {
      throw new ConflictException(MISMATCH);
    }

    const claimed = await this.prisma.inTenant(tenantId, (tx) =>
      claimRow(tx, 'file_version', versionId, ['pending'], 'completing'),
    );
    if (!claimed) {
      return toVersionResponse(await this.findVersion(tenantId, fileId, versionId));
    }

    try {
      // Only if the upload key still holds the object that was just checked.
      await this.storage.copy(uploadKey, version.storageKey, { ifMatchEtag: uploaded.etag });
      const copied = await this.storage.head(version.storageKey);
      if (!copied || !this.matchesDeclaration(copied, version)) {
        throw new ConflictException(MISMATCH);
      }
    } catch (error) {
      // Unless the copy was refused outright, a final object may exist that
      // nothing checked: remove it before handing the claim back.
      if (!(error instanceof ObjectNotFoundError || error instanceof ObjectChangedError)) {
        await this.discard(version.storageKey);
      }
      await this.release(tenantId, versionId);
      if (error instanceof ObjectNotFoundError) {
        throw new ConflictException('Upload not found');
      }
      if (error instanceof ObjectChangedError) {
        throw new ConflictException('Upload changed while completing');
      }
      throw error;
    }

    const { won, current } = await this.prisma.inTenant(tenantId, async (tx) => {
      const { count } = await tx.fileVersion.updateMany({
        where: { id: versionId, status: 'completing' },
        data: { status: 'uploaded', completedAt: new Date(), claimedAt: null },
      });
      return { won: count === 1, current: await tx.fileVersion.findUniqueOrThrow({ where: { id: versionId } }) };
    });
    if (!won) {
      // The sweeper took the claim back while this ran; whoever holds it now finishes.
      return toVersionResponse(current);
    }

    // After the commit, so the job never finds the version still completing. A
    // lost enqueue is recovered by the claim sweeper a minute after completion.
    try {
      await this.jobs.enqueue('file.measure', { tenantId, fileId, versionId });
    } catch (error) {
      this.logger.warn(
        `Could not enqueue measurement of version ${versionId}; the sweeper will: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // Last, so an upload key that is gone always means the version is uploaded.
    // A failure leaves the key to the bucket's lifecycle rule.
    try {
      await this.storage.delete(uploadKey);
    } catch (error) {
      this.logger.warn(
        `Could not delete upload key of version ${versionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return toVersionResponse(current);
  }

  /** A short-lived GET (plan S4, S8), once the upload has been completed. */
  async downloadUrl(tenantId: string, fileId: string, versionId: string): Promise<{ url: string; expires_at: string }> {
    const version = await this.findVersion(tenantId, fileId, versionId);
    // While completing, the final object may not exist yet.
    if (version.status === 'pending' || version.status === 'completing') {
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

  private matchesDeclaration(stored: StoredObject, version: { size: bigint; contentType: string }): boolean {
    return stored.size === Number(version.size) && stored.contentType.toLowerCase() === version.contentType;
  }

  /** Back to pending, so the client can try again. Never throws: the original error matters more. */
  private async release(tenantId: string, versionId: string): Promise<void> {
    try {
      await this.prisma.inTenant(tenantId, (tx) => releaseRow(tx, 'file_version', versionId, 'completing', 'pending'));
    } catch (error) {
      this.logger.warn(
        `Could not release the completion claim on ${versionId}; the sweeper will: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async discard(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn(`Could not delete ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
