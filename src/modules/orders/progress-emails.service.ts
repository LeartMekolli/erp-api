import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { planOf } from '../payments/plans/plan-of';
import type { WorkflowStepRow } from '../workflow/coverage';
import { pathFor } from '../workflow/path';
import type { StepConfig } from '../workflow/workflow-config';
import { chainOf, stepsForPath } from '../workflow/work-orders.service';

/**
 * Progress emails (Workflow 2 spec, goals 15–20): one per order and customer-facing step name, once every
 * live piece of the order whose path has an emailed step of that name is through one. Recorded and stored
 * as a pending notification in one transaction, so rework, replacements and corrections never send it
 * again, and a failure leaves neither behind; read against the customer's plan when it would go out.
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
    const stored = await this.prisma.inTenant(tenantId, async (tx) => {
      const touched = await tx.orderLine.findMany({
        where: { OR: [{ groupId: { in: groupIds } }, { parts: { some: { groupId: { in: groupIds } } } }] },
        select: { orderId: true },
      });
      const orders = await tx.order.findMany({
        where: { id: { in: [...new Set(touched.map((line) => line.orderId))] }, cancelledAt: null },
        select: { id: true, number: true, customerId: true, lines: { select: { groupId: true, cancelledAt: true, parts: { select: { groupId: true } } } } },
        orderBy: { id: 'asc' },
      });
      const recorded = new Map<string, Set<string>>();
      for (const row of await tx.orderProgressEmail.findMany({ where: { orderId: { in: orders.map((order) => order.id) } } })) {
        recorded.set(row.orderId, (recorded.get(row.orderId) ?? new Set()).add(row.stepName));
      }

      const steps = new StepsByVersion(tx);
      const ids: string[] = [];
      for (const order of orders) {
        const orderGroups = order.lines
          .filter((line) => line.cancelledAt === null)
          .flatMap((line) => [line.groupId, ...line.parts.map((part) => part.groupId)])
          .filter((groupId): groupId is string => groupId !== null);
        const sent = recorded.get(order.id) ?? new Set<string>();
        const unsent = [...(await emailedSteps(tx, steps, orderGroups))].filter(([name]) => !sent.has(name));
        if (unsent.length === 0 || !(await planOf(tx, order.customerId)).features.has('progress_emails')) {
          continue;
        }
        for (const [step, byGroup] of unsent.sort(([a], [b]) => a.localeCompare(b))) {
          if (!(await isThrough(tx, byGroup))) {
            continue;
          }
          const { count } = await tx.orderProgressEmail.createMany({ data: [{ orderId: order.id, stepName: step }], skipDuplicates: true });
          if (count > 0) {
            ids.push(await this.notifications.store(tx, 'order.progress', { type: 'order', id: order.id }, { number: String(order.number), step }));
          }
        }
      }
      return ids;
    });
    for (const notificationId of stored) {
      await this.notifications.queue(tenantId, notificationId);
    }
    return stored.length;
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

/** A group's emailed steps of one name, and the steps after the first of them on its path. */
interface EmailedAt {
  steps: Set<string>;
  after: Set<string>;
}

/** Each workflow version's steps, read once per run. */
class StepsByVersion {
  private readonly read = new Map<string, Promise<WorkflowStepRow[]>>();

  constructor(private readonly tx: Prisma.TransactionClient) {}

  of(versionId: string) {
    let steps = this.read.get(versionId);
    if (!steps) {
      steps = this.tx.workflowStep.findMany({ where: { versionId }, include: { stepType: true }, orderBy: { position: 'asc' } });
      this.read.set(versionId, steps);
    }
    return steps;
  }
}

/** By customer-facing name, the emailed steps on each of these groups' paths that has one. */
async function emailedSteps(tx: Prisma.TransactionClient, versions: StepsByVersion, groupIds: string[]): Promise<Map<string, Map<string, EmailedAt>>> {
  const groups = await tx.workOrderGroup.findMany({ where: { id: { in: groupIds } } });
  const emailed = new Map<string, Map<string, EmailedAt>>();
  for (const group of groups) {
    const steps = await versions.of(group.workflowVersionId);
    const path = pathFor(stepsForPath(steps), chainOf(group));
    const byId = new Map(steps.map((step) => [step.id, step]));
    path.forEach((stepId, index) => {
      const { customer } = byId.get(stepId)!.config as StepConfig;
      if (!customer.visible || !customer.email) {
        return;
      }
      const byGroup = emailed.get(customer.name) ?? new Map<string, EmailedAt>();
      const at = byGroup.get(group.id) ?? { steps: new Set<string>(), after: new Set(path.slice(index + 1)) };
      at.steps.add(stepId);
      byGroup.set(group.id, at);
      emailed.set(customer.name, byGroup);
    });
  }
  return emailed;
}

/**
 * Whether every live piece (active or finished) of these groups is through one of their emailed steps of
 * a name: it passed one, or failed there and continued; it stands at a step after it, as a correction
 * forward leaves it; or it is finished.
 */
async function isThrough(tx: Prisma.TransactionClient, byGroup: Map<string, EmailedAt>): Promise<boolean> {
  const pieces = await tx.workOrder.findMany({
    where: { groupId: { in: [...byGroup.keys()] }, status: { in: ['active', 'finished'] } },
    select: {
      groupId: true,
      status: true,
      currentStepId: true,
      transitions: { where: { OR: [{ kind: 'pass' }, { kind: 'fail', outcome: 'continue' }] }, select: { fromStepId: true } },
    },
  });
  const through = (piece: (typeof pieces)[number]) => {
    const at = byGroup.get(piece.groupId)!;
    return (
      piece.status === 'finished' ||
      (piece.currentStepId !== null && at.after.has(piece.currentStepId)) ||
      piece.transitions.some((transition) => transition.fromStepId !== null && at.steps.has(transition.fromStepId))
    );
  };
  return pieces.length > 0 && pieces.every(through);
}
