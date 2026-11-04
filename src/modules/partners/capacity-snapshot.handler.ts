import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { HandlesJob, JobHandler } from '../../jobs/handles-job';
import { EligibilityService } from './eligibility.service';

/**
 * Daily at 02:00 UTC (SCHEDULED_JOBS['partners.capacity.snapshot']). Keeps each partner's load and
 * capacity at each step type it can do, for the UTC day (Partners spec, D83). Safe to run again: a
 * second run the same day replaces that day's rows with the load as it is now.
 */
@Injectable()
@HandlesJob('partners.capacity.snapshot')
export class CapacitySnapshotHandler implements JobHandler<Record<string, never>> {
  private readonly logger = new Logger(CapacitySnapshotHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
  ) {}

  async handle(): Promise<void> {
    const at = new Date();
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const tenant of tenants) {
      // One workspace failing must not cost the others their day.
      try {
        await this.snapshot(tenant.id, at);
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'keeping partner capacity failed for a workspace');
      }
    }
  }

  /** One workspace's rows for the UTC day of `at`. */
  async snapshot(tenantId: string, at: Date): Promise<void> {
    const date = new Date(`${at.toISOString().slice(0, 10)}T00:00:00Z`);
    await this.prisma.inTenant(tenantId, async (tx) => {
      const capabilities = await tx.partnerCapability.findMany({
        select: { partnerId: true, stepTypeId: true, capacity: true, capacityPeriod: true },
      });
      if (capabilities.length === 0) return;
      const loads = await this.eligibility.loads(tx, [...new Set(capabilities.map((row) => row.partnerId))]);
      for (const row of capabilities) {
        const values = {
          load: loads.get(row.partnerId)?.get(row.stepTypeId) ?? 0,
          capacity: row.capacity,
          capacityPeriod: row.capacityPeriod,
        };
        await tx.partnerCapacitySnapshot.upsert({
          where: {
            tenantId_date_partnerId_stepTypeId: { tenantId, date, partnerId: row.partnerId, stepTypeId: row.stepTypeId },
          },
          create: { date, partnerId: row.partnerId, stepTypeId: row.stepTypeId, ...values },
          update: values,
        });
      }
      // A capability removed since an earlier run today no longer has a row for today.
      await tx.partnerCapacitySnapshot.deleteMany({
        where: {
          date,
          NOT: { OR: capabilities.map((row) => ({ partnerId: row.partnerId, stepTypeId: row.stepTypeId })) },
        },
      });
    });
  }
}
