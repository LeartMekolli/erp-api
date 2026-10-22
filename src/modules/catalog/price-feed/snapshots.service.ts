import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import type { FeedSnapshot } from '../material-price';

/**
 * Feed prices as dated snapshots (D87). Platform data, shared by every
 * tenant: one fetch per currency serves all of them. Quotes and checks read
 * here, never the provider.
 */
@Injectable()
export class SnapshotsService {
  constructor(private readonly prisma: PrismaService) {}

  async latest(metal: string, currency: string): Promise<FeedSnapshot | null> {
    const row = await this.prisma.metalPriceSnapshot.findFirst({
      where: { metal, currency },
      orderBy: { fetchedAt: 'desc' },
    });
    return row ? { pricePerGram: row.pricePerGram, currency: row.currency, fetchedAt: row.fetchedAt } : null;
  }

  async store(
    provider: string,
    currency: string,
    prices: { metal: string; pricePerGram: Prisma.Decimal }[],
    fetchedAt: Date,
  ): Promise<void> {
    await this.prisma.metalPriceSnapshot.createMany({
      data: prices.map((price) => ({ provider, metal: price.metal, currency, pricePerGram: price.pricePerGram, fetchedAt })),
    });
  }
}
