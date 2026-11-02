import { Prisma } from '../../generated/prisma/client';

/**
 * A workshop at fault is owed less for the original job (Orders 3 spec, goals 4 and 5): while the job is
 * not paid out, what it is owed is lowered, never below 0; what can't be taken off that way, all of it once
 * the job is paid out, is a shortfall for staff to settle by hand.
 */
export function planReduction(input: { owed: Prisma.Decimal; paidOut: boolean; amount: Prisma.Decimal }): {
  /** What the job is owed now; null when it is left as it was. */
  owed: Prisma.Decimal | null;
  reduced: Prisma.Decimal;
  shortfall: Prisma.Decimal;
} {
  if (input.paidOut) return { owed: null, reduced: new Prisma.Decimal(0), shortfall: input.amount };
  const reduced = Prisma.Decimal.min(input.owed, input.amount);
  return { owed: input.owed.sub(reduced), reduced, shortfall: input.amount.sub(reduced) };
}

/**
 * Lowers what an assignment is owed by `amount`, under its lock, through its `owedOverride` with the
 * reason. "Paid out" means a pending or paid payout holds the job.
 */
export async function reduceOwed(
  tx: Prisma.TransactionClient,
  assignmentId: string,
  amount: Prisma.Decimal,
  reason: string,
): Promise<{ reduced: Prisma.Decimal; shortfall: Prisma.Decimal }> {
  await tx.$queryRaw`SELECT id FROM job_assignment WHERE id = ${assignmentId}::uuid FOR UPDATE`;
  const assignment = await tx.jobAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
  const paidOut = (await tx.payoutJob.count({ where: { assignmentId, payout: { status: { in: ['pending', 'paid'] } } } })) > 0;
  const plan = planReduction({ owed: assignment.owedOverride ?? assignment.cost, paidOut, amount });
  if (plan.owed) {
    await tx.jobAssignment.update({ where: { id: assignmentId }, data: { owedOverride: plan.owed, owedOverrideReason: reason } });
  }
  return { reduced: plan.reduced, shortfall: plan.shortfall };
}
