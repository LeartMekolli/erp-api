import { Prisma } from '../../generated/prisma/client';

// What a partner is due (Payments spec): what each job is owed now, less what payouts have paid or are
// paying for it. Never stored: a correction or a new amount shows in the next payout.

/**
 * `owedNow` only when the job is owed now (null otherwise); `paidSoFar` is what pending and paid
 * payouts hold for it. Negative when more was paid than is owed now.
 */
export function dueFor(owedNow: Prisma.Decimal | null, paidSoFar: Prisma.Decimal): Prisma.Decimal {
  return (owedNow ?? new Prisma.Decimal(0)).sub(paidSoFar);
}

/** A payout's lines: every job with something due either way. Only a total above zero can be paid. */
export function payoutLines(jobs: { assignmentId: string; due: Prisma.Decimal }[]): {
  lines: { assignmentId: string; amount: Prisma.Decimal }[];
  total: Prisma.Decimal;
} {
  const lines = jobs.filter((job) => !job.due.isZero()).map((job) => ({ assignmentId: job.assignmentId, amount: job.due }));
  return { lines, total: lines.reduce((sum, line) => sum.add(line.amount), new Prisma.Decimal(0)) };
}
