import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { AiRun } from '../../generated/prisma/client';
import { JobsService } from '../../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { monthBounds, noticeLevel } from './ai-limit';
import { costOf, worstRunCost } from './ai-models';
import type { AiResponse } from './ai-provider';
import type { RecordRef } from './tools/tool';

export type RunKind = 'ask' | 'briefing';

export interface RunResult {
  status: 'done' | 'failed';
  usage: AiResponse['usage'];
  model: string;
  output: object | null;
  refs: RecordRef[];
  error: string | null;
}

/** What a kind's handler gives back; the model is the run's. A failed outcome still pays its tokens. */
export type RunOutcome = Omit<RunResult, 'model'>;

type KindHandler = (tenantId: string, run: AiRun) => Promise<RunOutcome>;

/** A run waiting longer than this is taken as lost: it no longer holds back its reserve, and is never run. */
const PENDING_WINDOW_MS = 60 * 60 * 1000;

type Tx = Prisma.TransactionClient;

/** The notice levels newly crossed this month, with the figures they are told with; null without a limit. */
type Crossed = { raised: number[]; limit: Prisma.Decimal; spent: Prisma.Decimal } | null;

/** Takes the workspace's AI-limit lock for the transaction. Always taken alone, never with another lock. */
function lockLimit(tx: Tx, tenantId: string): Promise<number> {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:ai_limit`}::text, 0))`;
}

/** What the workspace's AI has cost in the UTC month holding `at`. Runs in the transaction's workspace. */
export async function aiSpent(tx: Prisma.TransactionClient, at: Date): Promise<Prisma.Decimal> {
  const { start, end } = monthBounds(at);
  const sum = await tx.aiRunResult.aggregate({ where: { finishedAt: { gte: start, lt: end } }, _sum: { costUsd: true } });
  return sum._sum.costUsd ?? new Prisma.Decimal(0);
}

/**
 * AI runs (AI 1 spec): queued within the workspace's monthly limit, run by the `ai.run` job outside any
 * transaction, and logged insert only. Staff with `settings.write` are told once at 80 % and once at
 * 100 % each month.
 */
@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);
  private readonly handlers = new Map<RunKind, KindHandler>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Registers how runs of a kind are run. One handler per kind. */
  onKind(kind: RunKind, handler: KindHandler): void {
    this.handlers.set(kind, handler);
  }

  /**
   * Refused with a 409, writing nothing, when the workspace has no limit or the month's spend and the
   * worst case of each run still waiting reach it, so at most one run is accepted past the limit.
   * `check` runs under the limit's lock first (the briefing's refresh interval).
   */
  async queue(
    tenantId: string,
    input: { userId: string | null; kind: RunKind; payload: object },
    check?: (tx: Tx) => Promise<void>,
  ): Promise<{ runId: string }> {
    const runId = await this.prisma.inTenant(tenantId, async (tx) => {
      await lockLimit(tx, tenantId);
      await check?.(tx);
      const { aiMonthlyLimitUsd: limit } = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { aiMonthlyLimitUsd: true },
      });
      if (limit === null) {
        throw new ConflictException('AI is not set up for this workspace');
      }
      const now = new Date();
      // Counted before the spend: a run finishing in between is counted twice, never missed.
      const pending = await tx.aiRun.findMany({
        where: { result: { is: null }, createdAt: { gte: new Date(now.getTime() - PENDING_WINDOW_MS) } },
        select: { model: true },
      });
      const reserved = pending.reduce((sum, run) => sum.add(worstRunCost(run.model)), new Prisma.Decimal(0));
      if ((await aiSpent(tx, now)).add(reserved).gte(limit)) {
        throw new ConflictException("This month's AI limit is used");
      }
      const run = await tx.aiRun.create({
        data: {
          userId: input.userId,
          kind: input.kind,
          model: this.config.get('AI_MODEL'),
          input: input.payload as Prisma.InputJsonObject,
        },
      });
      return run.id;
    });
    await this.jobs.enqueue('ai.run', { tenantId, runId });
    return { runId };
  }

  /** The `ai.run` job: runs it by its kind and writes the result. A run already finished is left alone. */
  async execute(tenantId: string, runId: string): Promise<void> {
    const run = await this.prisma.inTenant(tenantId, (tx) =>
      tx.aiRun.findUnique({ where: { id: runId }, include: { result: { select: { id: true } } } }),
    );
    if (!run || run.result) return;
    // Its reserve has lapsed, so the limit no longer counts it: never run it now.
    if (Date.now() - run.createdAt.getTime() > PENDING_WINDOW_MS) {
      await this.fail(tenantId, runId, 'Not run in time');
      return;
    }
    const handler = this.handlers.get(run.kind as RunKind);
    if (!handler) {
      throw new Error(`No handler for AI runs of kind ${run.kind}`);
    }
    const outcome = await handler(tenantId, run);
    await this.finish(tenantId, runId, { ...outcome, model: run.model });
  }

  /** After the job's last attempt failed: a failed result, at no cost. */
  async fail(tenantId: string, runId: string, error: string): Promise<void> {
    const run = await this.prisma.inTenant(tenantId, (tx) => tx.aiRun.findUnique({ where: { id: runId } }));
    if (!run) return;
    await this.finish(tenantId, runId, {
      status: 'failed',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: run.model,
      output: null,
      refs: [],
      error,
    });
  }

  /**
   * Writes the run's result once, then tells staff of each notice level the month has newly crossed.
   * Under the limit's lock, so two runs finishing together each see the other's cost.
   */
  async finish(tenantId: string, runId: string, result: RunResult): Promise<void> {
    const crossed = await this.prisma.inTenant(tenantId, async (tx) => {
      await lockLimit(tx, tenantId);
      const written = await tx.aiRunResult.createMany({
        data: [
          {
            runId,
            status: result.status,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            costUsd: costOf(result.model, result.usage),
            output: result.output === null ? Prisma.DbNull : (result.output as Prisma.InputJsonObject),
            refs: result.refs.map((ref) => ({ type: ref.type, id: ref.id })),
            error: result.error,
          },
        ],
        skipDuplicates: true,
      });
      if (written.count === 0) return null;
      return this.crossedLevels(tx, tenantId);
    });
    await this.tell(tenantId, crossed);
  }

  /**
   * The `ai.limit.check` job, queued when a platform admin sets the limit: tells staff of each notice level
   * the month's spend has crossed against the new limit, once per month and level as always.
   */
  async checkNotices(tenantId: string): Promise<void> {
    const crossed = await this.prisma.inTenant(tenantId, async (tx) => {
      await lockLimit(tx, tenantId);
      return this.crossedLevels(tx, tenantId);
    });
    await this.tell(tenantId, crossed);
  }

  /** Records each notice level the month has newly crossed; the caller holds the limit's lock. */
  private async crossedLevels(tx: Tx, tenantId: string): Promise<Crossed> {
    const { aiMonthlyLimitUsd: limit } = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { aiMonthlyLimitUsd: true },
    });
    if (limit === null) return null;
    const now = new Date();
    const spent = await aiSpent(tx, now);
    const level = noticeLevel(spent, limit);
    const levels = level === 100 ? [80, 100] : level === 80 ? [80] : [];
    const raised: number[] = [];
    for (const one of levels) {
      const notice = await tx.aiLimitNotice.createMany({ data: [{ month: monthBounds(now).key, level: one }], skipDuplicates: true });
      if (notice.count > 0) raised.push(one);
    }
    return { raised, limit, spent };
  }

  private async tell(tenantId: string, crossed: Crossed): Promise<void> {
    if (!crossed) return;
    for (const level of crossed.raised) {
      try {
        await this.notifications.raise(
          tenantId,
          level === 100 ? 'ai.limit_used' : 'ai.limit_nearly_used',
          { type: 'tenant', id: tenantId },
          { limit: crossed.limit.toFixed(2), spent: crossed.spent.toFixed(2) },
        );
      } catch (error) {
        this.logger.error({ err: error, tenantId }, 'a notice about the AI limit failed');
      }
    }
  }

  spent(tx: Prisma.TransactionClient, at: Date): Promise<Prisma.Decimal> {
    return aiSpent(tx, at);
  }
}
