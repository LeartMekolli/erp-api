import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { planOf } from '../payments/plans/plan-of';
import { pathFor } from '../workflow/path';
import type { StepConfig } from '../workflow/workflow-config';
import { chainOf, stepsForPath } from '../workflow/work-orders.service';

/**
 * Progress emails (Workflow 2 spec, goals 15–20): one per order and customer-facing step name, once every
 * live piece of the order whose path has an emailed step of that name has passed one. Recorded before it
 * is raised, so rework, replacements and corrections never send it again; read against the customer's
 * plan when it would go out.
 */
@Injectable()
export class ProgressEmailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Sends the emails due for the orders of these groups; answers how many were sent. */
  async sendDue(tenantId: string, groupIds: string[]): Promise<number> {
    if (groupIds.length === 0) {
      return 0;
    }
    const due = await this.prisma.inTenant(tenantId, async (tx) => {
      const touched = await tx.orderLine.findMany({
        where: { OR: [{ groupId: { in: groupIds } }, { parts: { some: { groupId: { in: groupIds } } } }] },
        select: { orderId: true },
      });
      const orders = await tx.order.findMany({
        where: { id: { in: [...new Set(touched.map((line) => line.orderId))] }, cancelledAt: null },
        select: { id: true, number: true, customerId: true, lines: { select: { groupId: true, cancelledAt: true, parts: { select: { groupId: true } } } } },
        orderBy: { id: 'asc' },
      });
      const sent: { orderId: string; number: number; step: string }[] = [];
      for (const order of orders) {
        if (!(await planOf(tx, order.customerId)).features.has('progress_emails')) {
          continue;
        }
        const orderGroups = order.lines
          .filter((line) => line.cancelledAt === null)
          .flatMap((line) => [line.groupId, ...line.parts.map((part) => part.groupId)])
          .filter((groupId): groupId is string => groupId !== null);
        for (const step of await doneStepNames(tx, orderGroups)) {
          const { count } = await tx.orderProgressEmail.createMany({ data: [{ orderId: order.id, stepName: step }], skipDuplicates: true });
          if (count > 0) {
            sent.push({ orderId: order.id, number: order.number, step });
          }
        }
      }
      return sent;
    });
    for (const email of due) {
      await this.notifications.raise(tenantId, 'order.progress', { type: 'order', id: email.orderId }, {
        number: String(email.number),
        step: email.step,
      });
    }
    return due.length;
  }

  /** The groups with a move in the last 24 hours, for the sweep behind the job. */
  async recentlyMoved(tenantId: string, since: Date): Promise<string[]> {
    const rows = await this.prisma.inTenant(tenantId, (tx) =>
      tx.$queryRaw<{ group_id: string }[]>`
        SELECT DISTINCT wo.group_id FROM transition t JOIN work_order wo ON wo.id = t.work_order_id
        WHERE t.created_at >= ${since}`,
    );
    return rows.map((row) => row.group_id);
  }
}

/**
 * The customer-facing names of emailed steps on these groups' paths that every live piece (active or
 * finished) of the groups whose path has one has passed, or failed there and continued.
 */
async function doneStepNames(tx: Prisma.TransactionClient, groupIds: string[]): Promise<string[]> {
  const groups = await tx.workOrderGroup.findMany({ where: { id: { in: groupIds } } });
  // By step name: the emailed steps of each group whose path has one.
  const emailed = new Map<string, Map<string, Set<string>>>();
  for (const group of groups) {
    const steps = await tx.workflowStep.findMany({ where: { versionId: group.workflowVersionId }, include: { stepType: true }, orderBy: { position: 'asc' } });
    const path = new Set(pathFor(stepsForPath(steps), chainOf(group)));
    for (const step of steps.filter((candidate) => path.has(candidate.id))) {
      const { customer } = step.config as StepConfig;
      if (customer.visible && customer.email) {
        const byGroup = emailed.get(customer.name) ?? new Map<string, Set<string>>();
        byGroup.set(group.id, (byGroup.get(group.id) ?? new Set()).add(step.id));
        emailed.set(customer.name, byGroup);
      }
    }
  }

  const done: string[] = [];
  for (const [name, byGroup] of emailed) {
    const pieces = await tx.workOrder.findMany({
      where: { groupId: { in: [...byGroup.keys()] }, status: { in: ['active', 'finished'] } },
      select: {
        groupId: true,
        transitions: { where: { OR: [{ kind: 'pass' }, { kind: 'fail', outcome: 'continue' }] }, select: { fromStepId: true } },
      },
    });
    const passed = (piece: (typeof pieces)[number]) =>
      piece.transitions.some((transition) => transition.fromStepId !== null && byGroup.get(piece.groupId)!.has(transition.fromStepId));
    if (pieces.length > 0 && pieces.every(passed)) {
      done.push(name);
    }
  }
  return done.sort();
}
