import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { jobLabel } from './jobs.service';
import { pathOf, versionSteps } from './partner-jobs.service';
import { stageOf } from './partner-stage';

/**
 * Tells a partner when a move sent pieces it had finished its part of back to it (partner step rules spec,
 * part 3): from `done` (or finished) to one of its steps, or to a workspace step with one of its steps still
 * ahead. Without this a finished job would reopen silently. Run after the move commits, per move.
 */
@Injectable()
export class ReworkNoticeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async notify(tenantId: string, moveId: string): Promise<void> {
    const notices = await this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.transition.findMany({
        where: { moveId },
        select: { fromStepId: true, toStepId: true, toStatus: true, workOrder: { select: { groupId: true } } },
      });
      const found = [];
      for (const groupId of new Set(rows.map((row) => row.workOrder.groupId))) {
        const held = await tx.jobAssignment.findFirst({ where: { groupId, status: 'accepted' } });
        if (!held) continue;
        const group = await tx.workOrderGroup.findUniqueOrThrow({ where: { id: groupId } });
        const path = pathOf(await versionSteps(tx, group), group);
        // A piece with no step before the move was finished: past the partner's part, like `done`.
        const before = (stepId: string | null) => (stepId === null ? 'done' : stageOf(path, { status: 'active', currentStepId: stepId }));
        const after = (stepId: string | null) => stageOf(path, { status: 'active', currentStepId: stepId });
        const back = rows.filter(
          (row) =>
            row.workOrder.groupId === groupId &&
            row.toStatus === 'active' &&
            before(row.fromStepId) === 'done' &&
            ['yours', 'not_yet'].includes(after(row.toStepId) ?? ''),
        );
        if (back.length > 0) {
          found.push({ assignmentId: held.id, pieces: back.length, label: await jobLabel(tx, groupId) });
        }
      }
      return found;
    });
    for (const notice of notices) {
      await this.notifications.raise(tenantId, 'partner.job.reworked', { type: 'job_assignment', id: notice.assignmentId }, {
        product_name: notice.label.productName,
        quantity: String(notice.label.quantity),
        pieces: String(notice.pieces),
      });
    }
  }
}
