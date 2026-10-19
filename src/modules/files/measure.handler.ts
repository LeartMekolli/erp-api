import { createHash } from 'node:crypto';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { claimRow, releaseRow } from '../../jobs/claims';
import { ClaimSweeper } from '../../jobs/claim-sweeper';
import { HandlesJob, JobHandler } from '../../jobs/handles-job';
import { JobsService } from '../../jobs/jobs.service';
import type { ObjectStorage } from '../../storage/object-storage';
import { STORAGE } from '../../storage/object-storage';
import { MEASURE_TYPES, MEASURE_UNITS, MEASURERS, measurerFor } from './measurers';
import type { Measurer } from './measurers';

interface MeasurePayload {
  tenantId: string;
  fileId: string;
  versionId: string;
}

const DECIMAL = /^-?\d{1,12}(\.\d{1,6})?$/;
const measureTypes: ReadonlySet<string> = new Set(MEASURE_TYPES);
const measureUnits: ReadonlySet<string> = new Set(MEASURE_UNITS);

/**
 * Checksums and measures one completed version (spec 5.3, plan S5): claims it
 * (rule A1), streams the object once through SHA-256, hands it to the measurer
 * for its content type, then stores the result in one transaction. The long
 * work runs outside any transaction; a failure hands the claim back so the
 * retry can take it.
 */
@Injectable()
@HandlesJob('file.measure')
export class MeasureHandler implements JobHandler<MeasurePayload>, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly sweeper: ClaimSweeper,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
    @Inject(MEASURERS) private readonly measurers: readonly Measurer[],
  ) {}

  /** Completed versions whose job was lost, and claims whose runner died, are queued again. */
  onModuleInit(): void {
    this.sweeper.register({
      table: 'file_version',
      pending: 'uploaded',
      claimed: 'measuring',
      lostAfterMs: 60_000,
      // A version waits from its completion, not from when the upload started.
      lostSince: 'completed_at',
      staleAfterMs: 600_000,
      requeue: async (tenantId, versionId) => {
        const { fileId } = await this.prisma.inTenant(tenantId, (tx) =>
          tx.fileVersion.findUniqueOrThrow({ where: { id: versionId }, select: { fileId: true } }),
        );
        await this.jobs.requeue('file.measure', { tenantId, fileId, versionId });
      },
    });
  }

  async handle({ tenantId, versionId }: MeasurePayload): Promise<void> {
    // 'failed' is claimable too, so a platform admin's retry of a dead letter works.
    const claimed = await this.prisma.inTenant(tenantId, (tx) =>
      claimRow(tx, 'file_version', versionId, ['uploaded', 'failed'], 'measuring'),
    );
    if (!claimed) {
      return;
    }

    try {
      const version = await this.prisma.inTenant(tenantId, (tx) =>
        tx.fileVersion.findUniqueOrThrow({ where: { id: versionId }, include: { file: true } }),
      );

      const checksum = await this.sha256(version.storageKey);
      const measurer = measurerFor(version.contentType, this.measurers);
      const measures = await measurer.measure({
        contentType: version.contentType,
        declaredUnit: version.file.declaredUnit,
        read: () => this.storage.read(version.storageKey),
      });
      this.check(measurer.name, measures);

      await this.prisma.inTenant(tenantId, async (tx) => {
        const { count } = await tx.fileVersion.updateMany({
          where: { id: versionId, status: 'measuring' },
          data: { checksum, status: 'measured', claimedAt: null },
        });
        if (count === 0) {
          // The sweeper took the claim back; whoever holds it now writes the result.
          return;
        }
        await tx.measure.deleteMany({ where: { fileVersionId: versionId } });
        await tx.measure.createMany({
          data: measures.map((measure) => ({ fileVersionId: versionId, ...measure })),
        });
      });
    } catch (error) {
      // Hand the claim back, or the retry would find it taken and skip the
      // version for good (Review Focus 5).
      await this.prisma.inTenant(tenantId, (tx) => releaseRow(tx, 'file_version', versionId, 'measuring', 'uploaded'));
      throw error;
    }
  }

  async onDeadLetter({ tenantId, versionId }: MeasurePayload): Promise<void> {
    await this.prisma.inTenant(tenantId, (tx) =>
      tx.fileVersion.updateMany({
        where: { id: versionId, status: { in: ['uploaded', 'measuring'] } },
        data: { status: 'failed', claimedAt: null },
      }),
    );
  }

  private async sha256(key: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of await this.storage.read(key)) {
      hash.update(chunk as Uint8Array);
    }
    return hash.digest('hex');
  }

  /** A measurer that breaks the contract fails the same way on every attempt, so it is not retried. */
  private check(name: string, measures: { type: string; value: string; unit: string }[]): void {
    const seen = new Set<string>();
    for (const measure of measures) {
      if (
        !measureTypes.has(measure.type) ||
        !measureUnits.has(measure.unit) ||
        !DECIMAL.test(measure.value) ||
        seen.has(measure.type)
      ) {
        throw new UnrecoverableError(`Measurer ${name} returned an invalid ${measure.type} measure`);
      }
      seen.add(measure.type);
    }
  }
}
