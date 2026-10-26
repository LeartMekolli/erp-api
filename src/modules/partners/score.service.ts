import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { SettingsService } from '../settings/settings.service';
import type { PartnerScore } from './partner-response';
import { DEFAULT_SCORE_WEIGHTS, SCORE_DAYS, overallScore, scoreParts } from './score';
import type { ScoreWeights } from './score';

type Tx = Prisma.TransactionClient;

const DAY_MS = 86_400_000;

/** Partners' scores, read from their moves, offers and ratings of the last 90 days (Partners spec, goal 15). */
@Injectable()
export class ScoreService {
  constructor(private readonly settings: SettingsService) {}

  async scores(tx: Tx, partnerIds: string[]): Promise<Map<string, PartnerScore>> {
    const ids = [...new Set(partnerIds)];
    if (ids.length === 0) return new Map();
    const since = new Date(Date.now() - SCORE_DAYS * DAY_MS);
    const weights = ((await this.settings.list(tx))['partners.scoreWeights'] as ScoreWeights | undefined) ?? DEFAULT_SCORE_WEIGHTS;

    const moves = await tx.transition.findMany({
      where: { partnerId: { in: ids }, createdAt: { gte: since } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { partnerId: true, workOrderId: true, fromStepId: true, kind: true, toStatus: true },
    });
    const offers = await tx.jobAssignment.findMany({
      where: { partnerId: { in: ids }, kind: 'offer', createdAt: { gte: since } },
      select: { partnerId: true, status: true },
    });
    const ratings = await tx.jobRating.findMany({
      where: { partnerId: { in: ids }, createdAt: { gte: since } },
      select: { partnerId: true, stars: true },
    });
    // A finished job: the partner has it, and every live piece is finished. Counted, never loaded.
    const finished = await tx.jobAssignment.groupBy({
      by: ['partnerId'],
      where: {
        partnerId: { in: ids },
        status: 'accepted',
        group: { workOrders: { none: { status: 'active' }, some: { status: 'finished' } } },
      },
      _count: { _all: true },
    });

    return new Map(
      ids.map((partnerId) => {
        const parts = scoreParts({
          moves: moves.filter((move) => move.partnerId === partnerId),
          offers: offers.filter((offer) => offer.partnerId === partnerId),
          stars: ratings.filter((rating) => rating.partnerId === partnerId).map((rating) => rating.stars),
        });
        const finishedJobs = finished.find((row) => row.partnerId === partnerId)?._count._all ?? 0;
        return [
          partnerId,
          {
            overall: overallScore(parts, weights, finishedJobs),
            parts: {
              quality: parts.quality,
              scrap: parts.scrap,
              reliability: parts.reliability,
              on_time: parts.onTime,
              rating: parts.rating,
            },
            finished_jobs: finishedJobs,
          },
        ];
      }),
    );
  }

  async scoreOf(tx: Tx, partnerId: string): Promise<PartnerScore> {
    return (await this.scores(tx, [partnerId])).get(partnerId)!;
  }
}
