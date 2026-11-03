import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { AiRun, Prisma } from '../../../generated/prisma/client';
import type { TenantAuth } from '../../identity/auth-context';
import type { TenantPermission } from '../../identity/permissions';
import { notWaitingForPayment } from '../../orders/payment-hold';
import { jobSummaryOf, summaryStatus } from '../../partners/job-summary-response';
import type { JobSummaryResponse } from '../../partners/job-summary-response';
import type { SettingValue } from '../../settings/setting-keys';
import { SettingsService } from '../../settings/settings.service';
import { AI_PROVIDER } from '../ai-provider';
import type { AiProvider } from '../ai-provider';
import { runTools } from '../ask';
import { RunsService } from '../runs.service';
import type { RunOutcome } from '../runs.service';
import { jobSummaryFacts } from './summary-facts';
import { JOB_SUMMARY_TOOL, jobSummaryPrompt } from './summary-prompt';
import type { JobSummaryOutput } from './summary-prompt';

type Tx = Prisma.TransactionClient;

/** A job held longer than this when the sweep first sees it gets no summary: it is no longer news. */
const FRESH_MS = 24 * 60 * 60_000;
/** The most summaries one sweep queues per workspace. */
const PER_SWEEP = 20;

const DEFAULT_SETTINGS: SettingValue<'ai.jobSummary'> = { enabled: true };

/**
 * The AI's brief of each job for the workshop holding it (Orders 3 spec, goals 12–15). A sweep queues
 * one for each job newly held, however it was handed over; staff may ask for another. Runs within the
 * workspace's monthly AI limit, never with customers' credits.
 */
@Injectable()
export class JobSummaryService implements OnModuleInit {
  private readonly logger = new Logger(JobSummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RunsService,
    private readonly settings: SettingsService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  onModuleInit(): void {
    this.runs.onKind('job_summary', (tenantId, run) => this.write(tenantId, run));
  }

  /**
   * Queues a summary for each job the workspace's workshops have newly accepted, or been handed, with
   * none yet: at most 20, oldest first. None when the summary is off or AI isn't set up; a 409 from the
   * limit stops the run. Answers how many were queued.
   */
  async queueDue(tenantId: string, at: Date): Promise<number> {
    const since = new Date(at.getTime() - FRESH_MS);
    const due = await this.prisma.inTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { aiMonthlyLimitUsd: true } });
      if (tenant.aiMonthlyLimitUsd === null || !(await this.config(tx)).enabled) return [];
      return tx.jobAssignment.findMany({
        where: {
          status: 'accepted',
          summaries: { none: { requestedByUserId: null } },
          group: notWaitingForPayment,
          OR: [
            { respondedAt: { gte: since } },
            { respondedAt: null, createdAt: { gte: since } },
            // A job held while its order waited for payment is news once the order starts.
            { group: { orderLine: { is: { order: { productionStartedAt: { gte: since } } } } } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: PER_SWEEP,
        select: { id: true },
      });
    });
    let queued = 0;
    for (const assignment of due) {
      try {
        await this.queue(tenantId, assignment.id, null);
        queued += 1;
      } catch (error) {
        if (error instanceof ConflictException) break;
        throw error;
      }
    }
    return queued;
  }

  /** The scheduled `ai.job_summaries`: every active workspace with AI set up. One failing doesn't stop the rest. */
  async queueDueEverywhere(at: Date): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active', aiMonthlyLimitUsd: { not: null } }, select: { id: true } });
    for (const tenant of tenants) {
      try {
        await this.queueDue(tenant.id, at);
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'queueing job summaries failed for a workspace');
      }
    }
  }

  /** The job's latest summary, for staff. */
  async get(tenantId: string, groupId: string): Promise<JobSummaryResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      if (!(await tx.workOrderGroup.findUnique({ where: { id: groupId }, select: { id: true } }))) throw new NotFoundException('Job not found');
      return jobSummaryOf(tx, groupId);
    });
  }

  /**
   * Staff ask for the summary to be written again, for the job's current workshop. A 409 while one is
   * being written, when no workshop holds the job, when the summary is off, or when AI isn't set up or
   * its limit is used.
   */
  async rewrite(auth: TenantAuth, groupId: string): Promise<JobSummaryResponse> {
    // On top of the route's partner.assign: it spends the workspace's AI limit.
    if (!auth.permissions.has('ai.use')) throw new ForbiddenException('Writing a summary needs ai.use');
    const assignmentId = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      if (!(await tx.workOrderGroup.findUnique({ where: { id: groupId }, select: { id: true } }))) throw new NotFoundException('Job not found');
      const held = await tx.jobAssignment.findFirst({ where: { groupId, status: 'accepted' }, select: { id: true } });
      if (!held) throw new ConflictException('No workshop holds this job');
      if (!(await this.config(tx)).enabled) throw new ConflictException('Job summaries are switched off for this workspace');
      return held.id;
    });
    await this.queue(auth.tenantId, assignmentId, auth.userId);
    return this.get(auth.tenantId, groupId);
  }

  /** One run and its summary row in one transaction, then the run's job. */
  private async queue(tenantId: string, assignmentId: string, userId: string | null): Promise<void> {
    const runId = await this.prisma.inTenant(tenantId, async (tx) => {
      // The job's row lock orders the check against another sweep or a second request.
      await tx.$queryRaw`SELECT 1 FROM job_assignment WHERE id = ${assignmentId}::uuid FOR UPDATE`;
      const latest = await tx.jobSummary.findFirst({
        where: { assignmentId },
        orderBy: { createdAt: 'desc' },
        include: { run: { select: { createdAt: true, result: { select: { id: true } } } } },
      });
      // A run never run in time is dead, so its summary may be written again.
      if (latest && summaryStatus(latest) === 'pending') throw new ConflictException('A summary of this job is being written');
      // Not the user's own run: a staff request for a workshop's brief stays out of their Cmd+K history.
      const id = await this.runs.queueIn(tx, tenantId, { userId: null, kind: 'job_summary', payload: { assignment_id: assignmentId } });
      await tx.jobSummary.create({ data: { assignmentId, runId: id, requestedByUserId: userId } });
      return id;
    });
    await this.runs.enqueueRun(tenantId, runId);
  }

  /** The `job_summary` kind: the facts, one call with no tools, then the content once. */
  private async write(tenantId: string, run: AiRun): Promise<RunOutcome> {
    const { assignment_id: assignmentId } = run.input as unknown as { assignment_id: string };
    const { facts, instructions } = await this.prisma.inTenant(tenantId, async (tx) => ({
      facts: await jobSummaryFacts(tx, assignmentId, await this.settings.list(tx)),
      instructions: (await this.config(tx)).instructions,
    }));
    const outcome = await runTools(this.provider, {
      model: run.model,
      system: jobSummaryPrompt(facts, instructions),
      question: 'Write the summary of this job for the workshop.',
      tools: [],
      ctx: { tenantId, permissions: new Set<TenantPermission>(), userId: null },
      final: JOB_SUMMARY_TOOL,
    });
    if (outcome.status !== 'done' || !outcome.output) return outcome;

    const summary = outcome.output as JobSummaryOutput;
    await this.prisma.inTenant(tenantId, (tx) =>
      // A retried run writes its content once.
      tx.jobSummary.updateMany({
        where: { runId: run.id, description: null },
        data: {
          description: summary.description,
          watchOuts: summary.watch_outs,
          recommendations: summary.recommendations,
          productionDays: summary.production_days,
          usedHistory: summary.used_history,
        },
      }),
    );
    return outcome;
  }

  private async config(tx: Tx): Promise<SettingValue<'ai.jobSummary'>> {
    return ((await this.settings.list(tx))['ai.jobSummary'] as SettingValue<'ai.jobSummary'> | undefined) ?? DEFAULT_SETTINGS;
  }
}
