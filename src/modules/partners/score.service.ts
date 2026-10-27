import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { localDate } from '../orders/dates';
import { SettingsService } from '../settings/settings.service';
import { payoutStepId } from '../workflow/partner-steps';
import { passedPayout } from './owed';
import type { PartnerScore } from './partner-response';
import { DEFAULT_SCORE_WEIGHTS, SCORE_DAYS, overallScore, scoreParts } from './score';
import type { ScoreFacts, ScoreWeights } from './score';

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

    const { jobs, today } = await this.dueJobs(tx, ids, since);

    return new Map(
      ids.map((partnerId) => {
        const parts = scoreParts({
          moves: moves.filter((move) => move.partnerId === partnerId),
          offers: offers.filter((offer) => offer.partnerId === partnerId),
          stars: ratings.filter((rating) => rating.partnerId === partnerId).map((rating) => rating.stars),
          jobs: jobs.get(partnerId) ?? [],
          today,
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

  /**
   * The partners' jobs with a due date, handed over in the period and accepted (or since moved on), each
   * with the workspace-local day its last live piece passed the payout step: null until every live piece has.
   * A piece's day is that of the move that took it past the payout step, from the step itself or before.
   */
  private async dueJobs(
    tx: Tx,
    partnerIds: string[],
    since: Date,
  ): Promise<{ jobs: Map<string, ScoreFacts['jobs']>; today: string }> {
    const [{ timezone }] = await tx.$queryRaw<{ timezone: string }[]>`
      SELECT timezone FROM tenant WHERE id = current_setting('app.current_tenant_id')::uuid`;
    const today = localDate(new Date(), timezone);
    const assignments = await tx.jobAssignment.findMany({
      where: { partnerId: { in: partnerIds }, dueOn: { not: null }, status: { in: ['accepted', 'replaced'] }, createdAt: { gte: since } },
      select: { partnerId: true, groupId: true, dueOn: true },
    });
    const groups = await tx.workOrderGroup.findMany({
      where: { id: { in: [...new Set(assignments.map((row) => row.groupId))] } },
      select: {
        id: true,
        workflowVersion: { select: { payoutStepId: true, steps: { select: { id: true, position: true, doneBy: true } } } },
        workOrders: { select: { id: true, status: true, currentStep: { select: { position: true } } } },
      },
    });
    const live = (status: string) => status === 'active' || status === 'finished';
    const transitions = await tx.transition.findMany({
      where: { workOrderId: { in: groups.flatMap((group) => group.workOrders.filter((piece) => live(piece.status)).map((piece) => piece.id)) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { workOrderId: true, fromStepId: true, toStepId: true, toStatus: true, createdAt: true },
    });

    const finishedOn = new Map<string, string | null>();
    for (const group of groups) {
      const { steps, payoutStepId: explicit } = group.workflowVersion;
      const positionOf = new Map(steps.map((step) => [step.id, step.position]));
      const payoutId = payoutStepId(steps, explicit);
      // A version without partner steps has no payout step: only finished pieces count as past it.
      const payout = payoutId === null ? Number.POSITIVE_INFINITY : positionOf.get(payoutId)!;
      const pieces = group.workOrders.filter((piece) => live(piece.status));
      const done = pieces.length > 0 && pieces.every((piece) => passedPayout({ status: piece.status, stepPosition: piece.currentStep?.position ?? null }, payout));
      if (!done) {
        finishedOn.set(group.id, null);
        continue;
      }
      const days = pieces.flatMap((piece) => {
        const own = transitions.filter((transition) => transition.workOrderId === piece.id);
        const crossing = own.findLast((transition) => {
          const landed = transition.toStatus === 'finished' || (transition.toStepId !== null && positionOf.get(transition.toStepId)! > payout);
          const from = transition.fromStepId === null ? Number.NEGATIVE_INFINITY : positionOf.get(transition.fromStepId)!;
          return landed && from <= payout;
        });
        const at = crossing ?? own.at(-1);
        return at ? [at.createdAt] : [];
      });
      finishedOn.set(group.id, days.length === 0 ? null : localDate(new Date(Math.max(...days.map((day) => day.getTime()))), timezone));
    }

    const jobs = new Map<string, ScoreFacts['jobs']>();
    for (const row of assignments) {
      jobs.set(row.partnerId, [
        ...(jobs.get(row.partnerId) ?? []),
        { dueOn: row.dueOn!.toISOString().slice(0, 10), finishedOn: finishedOn.get(row.groupId) ?? null },
      ]);
    }
    return { jobs, today };
  }

  async scoreOf(tx: Tx, partnerId: string): Promise<PartnerScore> {
    return (await this.scores(tx, [partnerId])).get(partnerId)!;
  }
}
