import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { JobAssignment, Prisma } from '../../generated/prisma/client';
import { FilesService } from '../files/files.service';
import type { PartnerAuth } from '../identity/auth-context';
import { actionFacts, listActions } from '../workflow/move-history';
import type { MoveHistoryQuery } from '../workflow/move-history';
import type { PartnerMoveHistoryResponse } from './partner-response';
import { actorOf, handedOverAt } from './partner-view';

type Tx = Prisma.TransactionClient;

/**
 * The moves on a job the partner holds (Move history spec): every move on its pieces, its own, the
 * workspace's and a previous partner's, but names and free text only on moves its own people made.
 */
@Injectable()
export class JobMovesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly config: ConfigService,
  ) {}

  /** Newest first, one item per action, a page at a time. */
  async list(auth: PartnerAuth, groupId: string, query: MoveHistoryQuery): Promise<PartnerMoveHistoryResponse> {
    const secret = this.config.get('APP_SECRET');
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const held = await heldJob(tx, auth, groupId);
      const { actions, next_cursor, counts } = await listActions(tx, groupId, query, secret);
      return {
        data: actions.map((rows) => {
          const { representative, answers, ...rest } = actionFacts(rows);
          const actor = actorOf(auth, representative);
          const own = actor.kind === 'own';
          return {
            ...rest,
            override_reason: own ? representative.overrideReason : null,
            comment: own ? representative.comment : null,
            answers: answers.map((answer) => ({ ...answer, note: own ? answer.note : null })),
            actor,
          };
        }),
        next_cursor,
        counts,
        handed_over_at: handedOverAt(held).toISOString(),
      };
    });
  }

  /** A signed link to a photo of a move with a row on a piece of the partner's job; any other is not found. */
  async photoUrl(auth: PartnerAuth, groupId: string, moveId: string, fileVersionId: string): Promise<{ url: string; expires_at: string }> {
    const version = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await heldJob(tx, auth, groupId);
      const photo = await tx.transitionPhoto.findFirst({
        where: { fileVersionId, transition: { moveId, workOrder: { groupId } } },
        select: { fileVersion: { select: { id: true, fileId: true } } },
      });
      return photo?.fileVersion;
    });
    if (!version) {
      throw new NotFoundException('Photo not found');
    }
    return this.files.downloadUrl(auth.tenantId, version.fileId, version.id);
  }
}

/** The partner's current hand-over of the job; a job it was only offered, or no longer holds, is not found. */
async function heldJob(tx: Tx, auth: PartnerAuth, groupId: string): Promise<JobAssignment> {
  const held = await tx.jobAssignment.findFirst({ where: { groupId, partnerId: auth.partnerId, status: 'accepted' } });
  if (!held) {
    throw new NotFoundException('Job not found');
  }
  return held;
}
