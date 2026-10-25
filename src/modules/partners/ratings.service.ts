import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { JobRating } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { CustomerAuth, PartnerAuth, TenantAuth } from '../identity/auth-context';
import type {
  CustomerRatingResponse,
  PartnerRatingsResponse,
  PartnerScoreResponse,
  RatingResponse,
} from './partner-response';
import { ScoreService } from './score.service';

export const rateSchema = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().trim().min(1).max(2000).optional(),
});

type Tx = Prisma.TransactionClient;
type Row = JobRating & { partner: { id: string; name: string }; customer: { id: string; name: string } };

const include = { partner: { select: { id: true, name: true } }, customer: { select: { id: true, name: true } } } as const;

function toRating(row: Row): RatingResponse {
  return {
    id: row.id,
    group_id: row.groupId,
    partner: row.partner,
    customer: row.customer,
    stars: row.stars,
    comment: row.comment,
    shared_with_partner: row.sharedWithPartner,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * Customers rate the jobs partners made for them, once each (Partners spec, goal 16). Staff see every
 * rating; a partner sees its stars, and a comment only once staff share it, never who wrote it (P15).
 */
@Injectable()
export class RatingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly score: ScoreService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Rates the customer's own finished job, for the partner that has it. A job made in-house has no
   * partner to rate; a job is rated once.
   */
  async rate(auth: CustomerAuth, groupId: string, input: z.infer<typeof rateSchema>): Promise<CustomerRatingResponse> {
    try {
      return await this.prisma.inTenant(auth.tenantId, async (tx) => {
        await lockGroup(tx, groupId);
        const group = await tx.workOrderGroup.findUniqueOrThrow({ where: { id: groupId }, select: { customerId: true } });
        if (group.customerId !== auth.customerId) {
          throw new NotFoundException('Job not found');
        }
        const assignment = await tx.jobAssignment.findFirst({ where: { groupId, status: 'accepted' }, select: { partnerId: true } });
        if (!assignment) {
          throw new ConflictException('The job was made in-house, so there is no workshop to rate');
        }
        const [active, finished] = await Promise.all([
          tx.workOrder.count({ where: { groupId, status: 'active' } }),
          tx.workOrder.count({ where: { groupId, status: 'finished' } }),
        ]);
        if (active > 0 || finished === 0) {
          throw new ConflictException('Only a finished job can be rated');
        }
        if (await tx.jobRating.findUnique({ where: { tenantId_groupId: { tenantId: auth.tenantId, groupId } }, select: { id: true } })) {
          throw new ConflictException('The job is rated already');
        }
        const row = await tx.jobRating.create({
          data: {
            groupId,
            partnerId: assignment.partnerId,
            customerId: auth.customerId,
            stars: input.stars,
            comment: input.comment ?? null,
            ratedByUserId: auth.userId,
          },
        });
        return { id: row.id, group_id: row.groupId, stars: row.stars, comment: row.comment, created_at: row.createdAt.toISOString() };
      });
    } catch (error) {
      // Two ratings of one job at once: the second meets the unique job.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('The job is rated already');
      }
      throw error;
    }
  }

  /** Staff: the partner's ratings, newest first, with who gave them and every comment. */
  async list(tenantId: string, partnerId: string): Promise<PartnerRatingsResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      if (!(await tx.partner.findUnique({ where: { id: partnerId }, select: { id: true } }))) {
        throw new NotFoundException('Partner not found');
      }
      const rows = await tx.jobRating.findMany({ where: { partnerId }, orderBy: { id: 'desc' }, include });
      return { data: rows.map(toRating) };
    });
  }

  /** Staff let the partner read the rating's comment; sharing it again changes nothing. */
  async share(auth: TenantAuth, id: string): Promise<RatingResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const current = await tx.jobRating.findUnique({ where: { id }, include });
      if (!current) {
        throw new NotFoundException('Rating not found');
      }
      if (current.sharedWithPartner) return toRating(current);
      const row = await tx.jobRating.update({ where: { id }, data: { sharedWithPartner: true }, include });
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'partner.changed',
        subject: { type: 'job_rating', id },
        before: { shared_with_partner: false },
        after: { shared_with_partner: true },
      });
      return toRating(row);
    });
  }

  /** The partner's own score and stars; a comment only once shared, and never the customer. */
  async mine(auth: PartnerAuth): Promise<PartnerScoreResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const rows = await tx.jobRating.findMany({ where: { partnerId: auth.partnerId }, orderBy: { id: 'desc' } });
      return {
        score: await this.score.scoreOf(tx, auth.partnerId),
        ratings: rows.map((row) => ({
          id: row.id,
          group_id: row.groupId,
          stars: row.stars,
          comment: row.sharedWithPartner ? row.comment : null,
          created_at: row.createdAt.toISOString(),
        })),
      };
    });
  }
}

/** Serialises ratings of one job; another workspace's group is not found. */
async function lockGroup(tx: Tx, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM work_order_group WHERE id = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) {
    throw new NotFoundException('Job not found');
  }
}
