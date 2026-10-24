import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { JobAssignment, Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { PartnerAuth, TenantAuth } from '../identity/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { EligibilityService, OPEN_STATUSES } from './eligibility.service';
import type { Job, Verdict } from './eligibility.service';
import type { JobAssignmentResponse, JobHistoryResponse } from './partner-response';

const MONEY = /^\d{1,16}(\.\d{1,2})?$/;

export const offerSchema = z.object({ partner_id: z.uuid() });

export const reassignSchema = z.object({
  partner_id: z.uuid(),
  /** What the partner the job is taken from is owed for the work it did; nothing when omitted (P16). */
  previous_owed: z
    .strictObject({
      amount: z.string().regex(MONEY, 'must be an amount with at most 2 places, such as 40.00'),
      reason: z.string().trim().min(1).max(500),
    })
    .optional(),
});

/** How long an offer stays open when the workspace hasn't set `partners.routing`. */
const DEFAULT_OFFER_HOURS = 24;
const HOUR_MS = 3_600_000;

type Tx = Prisma.TransactionClient;
type Row = JobAssignment & { partner: { id: string; name: string } };

export function toAssignment(row: Row): JobAssignmentResponse {
  return {
    id: row.id,
    group_id: row.groupId,
    partner: { id: row.partner.id, name: row.partner.name },
    kind: row.kind as JobAssignmentResponse['kind'],
    status: row.status as JobAssignmentResponse['status'],
    cost: row.cost.toFixed(2),
    owed_override:
      row.owedOverride !== null && row.owedOverrideReason !== null
        ? { amount: row.owedOverride.toFixed(2), reason: row.owedOverrideReason }
        : null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    responded_at: row.respondedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

const include = { partner: { select: { id: true, name: true } } } as const;

/**
 * Locks the job's group for the rest of the transaction, which keeps one open offer or assignment per
 * job (plan Review Focus 3). Row-level security hides other workspaces' groups, so a foreign id is not found.
 */
async function lockGroup(tx: Tx, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM work_order_group WHERE id = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) {
    throw new NotFoundException('Job not found');
  }
}

function refused(name: string, verdict: Extract<Verdict, { ok: false }>): ConflictException {
  return new ConflictException({
    message: `${name} cannot take this job`,
    errors: verdict.reasons.map((reason) => ({ path: 'partner_id', message: reason })),
  });
}

/** Jobs offered to partners, answered by them, and moved between them (Partners spec, goals 10 and P16). */
@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Offers the job to a partner that can take it, open until the workspace's deadline. Refused while
   * the job is offered or accepted already.
   */
  async offer(auth: TenantAuth, groupId: string, partnerId: string): Promise<JobAssignmentResponse> {
    const { row, job } = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockGroup(tx, groupId);
      await this.refuseOpen(tx, groupId);
      const { job, cost } = await this.able(tx, groupId, partnerId);
      const routing = (await this.settings.list(tx))['partners.routing'] as { offerHours: number } | undefined;
      const now = new Date();
      const created = await tx.jobAssignment.create({
        data: {
          groupId,
          partnerId,
          kind: 'offer',
          status: 'offered',
          cost,
          expiresAt: new Date(now.getTime() + (routing?.offerHours ?? DEFAULT_OFFER_HOURS) * HOUR_MS),
          createdByUserId: auth.userId,
        },
        include,
      });
      await this.record(tx, auth.userId, created);
      return { row: created, job };
    });
    // After commit: a notification never reports an offer that rolled back.
    await this.notifications.raise(auth.tenantId, 'partner.job.offered', { type: 'job_assignment', id: row.id }, {
      product_name: job.productName,
      quantity: String(job.quantity),
      expires_at: row.expiresAt!.toISOString(),
    });
    return toAssignment(row);
  }

  /** Takes back an offer nobody has answered. */
  async withdraw(auth: TenantAuth, groupId: string): Promise<JobAssignmentResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockGroup(tx, groupId);
      const current = await tx.jobAssignment.findFirst({ where: { groupId, status: 'offered' } });
      if (!current) {
        throw new ConflictException('The job has no open offer');
      }
      const row = await tx.jobAssignment.update({ where: { id: current.id }, data: { status: 'withdrawn' }, include });
      await this.record(tx, auth.userId, row);
      return toAssignment(row);
    });
  }

  /**
   * Moves an accepted job to another partner that can take it, which has it at once: staff have
   * arranged it. The partner it is taken from is owed `previous_owed`, else nothing (P16).
   */
  async reassign(auth: TenantAuth, groupId: string, input: z.infer<typeof reassignSchema>): Promise<JobAssignmentResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockGroup(tx, groupId);
      const current = await tx.jobAssignment.findFirst({ where: { groupId, status: 'accepted' } });
      if (!current) {
        throw new ConflictException('Only a job a partner has accepted can be moved');
      }
      if (current.partnerId === input.partner_id) {
        throw new ConflictException('The job is already with this partner');
      }
      const { cost } = await this.able(tx, groupId, input.partner_id);
      const replaced = await tx.jobAssignment.update({
        where: { id: current.id },
        data: {
          status: 'replaced',
          owedOverride: input.previous_owed?.amount ?? 0,
          owedOverrideReason: input.previous_owed?.reason ?? 'Moved to another partner',
        },
        include,
      });
      await this.record(tx, auth.userId, replaced);
      const row = await tx.jobAssignment.create({
        data: {
          groupId,
          partnerId: input.partner_id,
          kind: 'reassign',
          status: 'accepted',
          cost,
          createdByUserId: auth.userId,
        },
        include,
      });
      await this.record(tx, auth.userId, row);
      return toAssignment(row);
    });
  }

  /** Every time the job was handed to a partner, oldest first. */
  async history(tenantId: string, groupId: string): Promise<JobHistoryResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      if (!(await tx.workOrderGroup.findUnique({ where: { id: groupId }, select: { id: true } }))) {
        throw new NotFoundException('Job not found');
      }
      const rows = await tx.jobAssignment.findMany({ where: { groupId }, orderBy: { id: 'asc' }, include });
      return { data: rows.map(toAssignment) };
    });
  }

  /** The partner takes the offered job; only before its deadline, whether or not the expiry run has been (Review Focus 4). */
  async accept(auth: PartnerAuth, groupId: string): Promise<JobAssignmentResponse> {
    const { row } = await this.answer(auth, groupId, 'accepted');
    return toAssignment(row);
  }

  /** The partner turns the offered job down; staff are told, and the job needs a partner again. */
  async decline(auth: PartnerAuth, groupId: string): Promise<JobAssignmentResponse> {
    const { row, job } = await this.answer(auth, groupId, 'declined');
    await this.notifications.raise(auth.tenantId, 'partner.job.declined', { type: 'job_assignment', id: row.id }, {
      partner_name: row.partner.name,
      product_name: job.productName,
      quantity: String(job.quantity),
    });
    return toAssignment(row);
  }

  private async answer(auth: PartnerAuth, groupId: string, status: 'accepted' | 'declined'): Promise<{ row: Row; job: JobLabel }> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockGroup(tx, groupId);
      // A job never offered to this partner isn't there for it.
      const latest = await tx.jobAssignment.findFirst({
        where: { groupId, partnerId: auth.partnerId },
        orderBy: { id: 'desc' },
      });
      if (!latest) {
        throw new NotFoundException('Job not found');
      }
      if (latest.status !== 'offered' || !latest.expiresAt || Date.now() >= latest.expiresAt.getTime()) {
        throw new ConflictException('The job is not on offer to the partner any more');
      }
      const row = await tx.jobAssignment.update({
        where: { id: latest.id },
        data: { status, respondedAt: new Date() },
        include,
      });
      await this.record(tx, auth.userId, row);
      return { row, job: await jobLabel(tx, groupId) };
    });
  }

  /** The job can be handed to the partner: no other open offer or assignment, and the partner can take it. */
  private async able(tx: Tx, groupId: string, partnerId: string): Promise<{ job: JobLabel; cost: Prisma.Decimal }> {
    const partner = await tx.partner.findUnique({ where: { id: partnerId }, select: { name: true } });
    if (!partner) {
      throw new NotFoundException('Partner not found');
    }
    const job: Job = await this.eligibility.job(tx, groupId);
    const verdict = (await this.eligibility.judge(tx, job, [partnerId])).get(partnerId)!;
    if (!verdict.ok) {
      throw refused(partner.name, verdict);
    }
    return { job: await jobLabel(tx, groupId), cost: verdict.cost };
  }

  private async refuseOpen(tx: Tx, groupId: string): Promise<void> {
    if (await tx.jobAssignment.findFirst({ where: { groupId, status: { in: OPEN_STATUSES } }, select: { id: true } })) {
      throw new ConflictException('The job is already offered to or accepted by a partner');
    }
  }

  private async record(tx: Tx, userId: string, row: Row): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'user', id: userId },
      action: 'partner.job',
      subject: { type: 'job_assignment', id: row.id },
      after: toAssignment(row),
    });
  }
}

/** What a job's notifications name: never the customer. */
export interface JobLabel {
  productName: string;
  quantity: number;
}

export async function jobLabel(tx: Tx, groupId: string): Promise<JobLabel> {
  const group = await tx.workOrderGroup.findUniqueOrThrow({
    where: { id: groupId },
    select: { quantity: true, product: { select: { name: true } } },
  });
  return { productName: group.product?.name ?? 'a job', quantity: group.quantity };
}
