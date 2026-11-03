import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/** A run waiting longer than this is never run (RunsService), so its summary reads as failed. */
const PENDING_MS = 60 * 60_000;

/**
 * The content is written just before its run's result: with it, the summary is done; a run ended
 * without it, or never run in time, failed. Only a pending one blocks writing another.
 */
export function summaryStatus(row: { description: string | null; run: { createdAt: Date; result: object | null } }): 'pending' | 'done' | 'failed' {
  if (row.description !== null) return 'done';
  return row.run.result || Date.now() - row.run.createdAt.getTime() > PENDING_MS ? 'failed' : 'pending';
}

/**
 * The AI's brief of a job (Orders 3 spec, goals 14–15), for the workshop holding it and for staff; null
 * when none was written. Never a price, a customer's name or another workshop's.
 */
export const jobSummaryResponseSchema = z
  .strictObject({
    status: z.enum(['pending', 'done', 'failed']),
    description: z.string().nullable(),
    watch_outs: z.array(z.string()).nullable(),
    recommendations: z.array(z.string()).nullable(),
    /** Realistic working days to make the job, against its due date. */
    production_days: z.number().int().nullable(),
    /** Whether the workshop's own history was drawn on. */
    used_history: z.boolean().nullable(),
    created_at: z.string(),
  })
  .nullable();
export type JobSummaryResponse = z.infer<typeof jobSummaryResponseSchema>;

/** The latest summary of the job's current hand-over (offered or accepted), in the job's workspace. */
export async function jobSummaryOf(tx: Tx, groupId: string): Promise<JobSummaryResponse> {
  const row = await tx.jobSummary.findFirst({
    where: { assignment: { groupId, status: { in: ['offered', 'accepted'] } } },
    orderBy: { createdAt: 'desc' },
    include: { run: { select: { createdAt: true, result: { select: { status: true } } } } },
  });
  if (!row) return null;
  return {
    status: summaryStatus(row),
    description: row.description,
    watch_outs: (row.watchOuts as string[] | null) ?? null,
    recommendations: (row.recommendations as string[] | null) ?? null,
    production_days: row.productionDays,
    used_history: row.usedHistory,
    created_at: row.createdAt.toISOString(),
  };
}
