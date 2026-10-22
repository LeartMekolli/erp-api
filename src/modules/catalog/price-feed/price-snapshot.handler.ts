import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../../../config/config.service';
import { PrismaService } from '../../../database/prisma.service';
import { HandlesJob, JobHandler } from '../../../jobs/handles-job';
import { NotificationsService } from '../../notifications/notifications.service';
import { METAL_PRICE_PROVIDER } from './metal-price-provider';
import type { MetalPriceProvider } from './metal-price-provider';
import { SnapshotsService } from './snapshots.service';

const DAY_MS = 24 * 3_600_000;

/**
 * Daily at 05:00 UTC (SCHEDULED_JOBS['material.prices.fetch']). Fetches the
 * workspace currencies in use, most used first, up to the cap (spec B5), then
 * tells each tenant's catalog editors about feed materials without a fresh
 * price, once a day per material (spec B6). A provider failure never fails
 * the run: the last good snapshots stay in use.
 */
@Injectable()
@HandlesJob('material.prices.fetch')
export class PriceSnapshotHandler implements JobHandler<Record<string, never>> {
  private readonly logger = new Logger(PriceSnapshotHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly snapshots: SnapshotsService,
    private readonly notifications: NotificationsService,
    @Inject(METAL_PRICE_PROVIDER) private readonly provider: MetalPriceProvider,
  ) {}

  async handle(): Promise<void> {
    for (const currency of await this.currencies()) {
      try {
        const prices = await this.provider.latest(currency);
        await this.snapshots.store(this.provider.name, currency, prices, new Date());
      } catch (error) {
        this.logger.warn(
          `Metal prices in ${currency} not fetched from ${this.provider.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await this.alertStale();
  }

  /** Distinct currencies of active tenants, most tenants first, ties alphabetical, capped. */
  private async currencies(): Promise<string[]> {
    const groups = await this.prisma.tenant.groupBy({
      by: ['defaultCurrency'],
      where: { status: 'active' },
      _count: { _all: true },
    });
    return groups
      .sort((a, b) => b._count._all - a._count._all || a.defaultCurrency.localeCompare(b.defaultCurrency))
      .slice(0, this.config.get('METAL_PRICE_MAX_CURRENCIES'))
      .map((group) => group.defaultCurrency);
  }

  private async alertStale(): Promise<void> {
    const staleHours = this.config.get('METAL_PRICE_STALE_HOURS');
    const now = Date.now();
    const tenants = await this.prisma.tenant.findMany({
      where: { status: 'active' },
      select: { id: true, defaultCurrency: true },
    });

    for (const tenant of tenants) {
      // One workspace failing must not cost the others their alerts.
      try {
        const due = await this.prisma.inTenant(tenant.id, async (tx) => {
          const materials = await tx.material.findMany({
            where: { priceSource: 'feed', feedMetal: { not: null } },
            select: { id: true, name: true, feedMetal: true },
          });
          const alerts: { id: string; name: string; reason: string }[] = [];
          for (const material of materials) {
            const metal = material.feedMetal;
            if (!metal) continue;
            const snapshot = await this.snapshots.latest(metal, tenant.defaultCurrency);
            let reason: string;
            if (!snapshot) {
              reason = `There is no feed price for ${metal} in ${tenant.defaultCurrency}.`;
            } else if (now - snapshot.fetchedAt.getTime() > staleHours * 3_600_000) {
              reason = `The last feed price is from ${snapshot.fetchedAt.toISOString()}, older than ${staleHours} hours.`;
            } else {
              continue;
            }
            const recent = await tx.notification.count({
              where: {
                eventKey: 'material.price.stale',
                subjectId: material.id,
                createdAt: { gt: new Date(now - DAY_MS) },
              },
            });
            if (recent === 0) alerts.push({ id: material.id, name: material.name, reason });
          }
          return alerts;
        });

        for (const alert of due) {
          await this.notifications.raise(
            tenant.id,
            'material.price.stale',
            { type: 'material', id: alert.id },
            { material_name: alert.name, reason: alert.reason },
          );
        }
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'stale-price alerts failed for a workspace');
      }
    }
  }
}
