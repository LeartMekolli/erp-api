import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { JobAssignment, Prisma } from '../../generated/prisma/client';
import { FilesService } from '../files/files.service';
import type { PartnerAuth } from '../identity/auth-context';
import { actionFacts, listActions } from '../workflow/move-history';
import type { ActionRow, MoveHistoryQuery } from '../workflow/move-history';
import type { PartnerActionResponse, PartnerMoveHistoryResponse } from './partner-response';

type Tx = Prisma.TransactionClient;
type ActorKind = PartnerActionResponse['actor']['kind'];

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
          const kind = actorKind(auth, representative);
          const own = kind === 'own';
          return {
            ...rest,
            override_reason: own ? representative.overrideReason : null,
            comment: own ? representative.comment : null,
            answers: answers.map((answer) => ({ ...answer, note: own ? answer.note : null })),
            actor: { kind, name: own ? representative.actor.name : null },
          };
        }),
        next_cursor,
        counts,
        handed_over_at: (held.respondedAt ?? held.createdAt).toISOString(),
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

/**
 * Who made an action: the partner's own people, when a partner person made it for this partner (a partner's
 * move is always credited to the partner holding the job); another partner's people; or else the workspace.
 * Read from the move, not from who belongs to the partner now: a person of two partners stays with the one
 * they moved for, and a former member's moves stay the partner's own.
 */
function actorKind(auth: PartnerAuth, row: ActionRow): ActorKind {
  if (row.actor.kind !== 'partner') {
    return 'workspace';
  }
  return row.partnerId === auth.partnerId ? 'own' : 'other_partner';
}
