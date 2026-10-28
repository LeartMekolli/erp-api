import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../../common/pagination/cursor';
import type { PaginationQuery } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { JobAssignment } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditInput } from '../audit/audit.service';
import type { PartnerAuth, TenantAuth } from '../identity/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import { ONE_PARTNER, defaultDueOn, lockOrderOfGroup, otherLinePartners, workspaceToday } from '../orders/order-lines';
import { WAITING_FOR_PAYMENT, waitingGroupIds } from '../orders/payment-hold';
import { SettingsService } from '../settings/settings.service';
import { payoutStepId } from '../workflow/partner-steps';
import { WorkOrdersService } from '../workflow/work-orders.service';
import type { CancelledGroup } from '../workflow/work-orders.service';
import { EligibilityService, liveOpen } from './eligibility.service';
import type { Job, Verdict } from './eligibility.service';
import { owedFor, passedPayout } from './owed';
import type { JobAssignmentResponse, JobHistoryResponse, OwedJobResponse, PartnerOwedResponse } from './partner-response';
import { lockPartner } from './partners.service';

const MONEY = /^\d{1,16}(\.\d{1,2})?$/;

export const offerSchema = z.object({
  partner_id: z.uuid(),
  /** The day the job should be done by; from today on. Omitted: the order's promised date less a buffer (Orders spec, B3). */
  due_on: z.iso.date().optional(),
});

const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

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

/** Staff set what a partner is owed for a job instead of its cost, with a reason (Partners spec, goal 14). */
export const setOwedSchema = z.object({
  /** The partner the job is or was with: a job moved mid-way has two. */
  partner_id: z.uuid(),
  amount: z.string().regex(MONEY, 'must be an amount with at most 2 places, such as 180.00'),
  reason: z.string().trim().min(1).max(500),
});

/** The hand-overs a partner can be owed for: the job it has, those taken from it mid-way, and those whose order line was cancelled. */
const OWED_STATUSES = ['accepted', 'replaced', 'cancelled'];

/** How long an offer stays open when the workspace hasn't set `partners.routing`. */
const DEFAULT_OFFER_HOURS = 24;
const HOUR_MS = 3_600_000;

type Tx = Prisma.TransactionClient;
type Routing = { offerHours: number; splitOrderLines: boolean };
type Row =JobAssignment & { partner: { id: string; name: string } };

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
    due_on: row.dueOn?.toISOString().slice(0, 10) ?? null,
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

/** A job of an order waiting for payment is neither offered nor moved (Payments spec, B1). */
async function refuseWaiting(tx: Tx, groupId: string): Promise<void> {
  if ((await waitingGroupIds(tx, [groupId])).size > 0) {
    throw new ConflictException(WAITING_FOR_PAYMENT);
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
export class JobsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly workOrders: WorkOrdersService,
  ) {}

  onModuleInit(): void {
    // A job whose order line is cancelled lets go of its partner (Orders spec, goal 12).
    this.workOrders.registerCancelHook((tx, cancelled) => this.cancelForLine(tx, cancelled));
  }

  /**
   * The job's order line was cancelled, under the group lock the caller holds: an open offer is
   * withdrawn; an accepted job is cancelled and owed what staff set, else nothing, at once (as P16
   * for a moved job). Any other job has nobody to let go.
   */
  async cancelForLine(tx: Tx, cancelled: CancelledGroup): Promise<void> {
    const holding = await tx.jobAssignment.findFirst({ where: { groupId: cancelled.groupId, status: { in: ['offered', 'accepted'] } } });
    if (!holding) return;
    const row = await tx.jobAssignment.update({
      where: { id: holding.id },
      data:
        holding.status === 'offered'
          ? { status: 'withdrawn' }
          : {
              status: 'cancelled',
              owedOverride: cancelled.partnerOwed?.amount ?? 0,
              owedOverrideReason: cancelled.partnerOwed?.reason ?? 'The order line was cancelled',
            },
      include,
    });
    await this.record(tx, cancelled.userId, row);
  }

  /**
   * A paid order has started (Payments spec): each job its workshop held while it waited is due by the
   * new promised date, or, when the workshop has been suspended since, withdrawn, which leaves the line
   * in-house. In the caller's transaction, after the order's lock. Answers the jobs to tell their
   * workshops of, and the groups that lost theirs, with the workshop's name.
   */
  async startHeldJobs(
    tx: Tx,
    tenantId: string,
    groupIds: string[],
    actor: AuditInput['actor'],
  ): Promise<{ handedOver: string[]; lost: { groupId: string; partnerName: string }[] }> {
    const held = await tx.jobAssignment.findMany({
      where: { groupId: { in: groupIds }, status: 'accepted' },
      orderBy: { groupId: 'asc' },
      include: { partner: { select: { id: true, name: true, status: true } } },
    });
    const settings = await this.settings.list(tx);
    const today = await workspaceToday(tx, tenantId);
    const handedOver: string[] = [];
    const lost: { groupId: string; partnerName: string }[] = [];
    for (const job of held) {
      await lockGroup(tx, job.groupId);
      if (job.partner.status === 'suspended') {
        const row = await tx.jobAssignment.update({ where: { id: job.id }, data: { status: 'withdrawn' }, include });
        await this.audit.record(tx, { actor, action: 'partner.job', subject: { type: 'job_assignment', id: row.id }, after: toAssignment(row) });
        lost.push({ groupId: job.groupId, partnerName: job.partner.name });
        continue;
      }
      const due = await defaultDueOn(tx, job.groupId, settings, today);
      const row = await tx.jobAssignment.update({ where: { id: job.id }, data: { dueOn: due ? asDate(due) : null }, include });
      await this.audit.record(tx, { actor, action: 'partner.job', subject: { type: 'job_assignment', id: row.id }, after: toAssignment(row) });
      handedOver.push(row.id);
    }
    return { handedOver, lost };
  }

  /** Tells each workshop of a job it has had since its order was placed, now the order has started; after commit. */
  async notifyDirect(tenantId: string, assignmentIds: string[]): Promise<void> {
    for (const id of assignmentIds) {
      const label = await this.prisma.inTenant(tenantId, async (tx) =>
        jobLabel(tx, (await tx.jobAssignment.findUniqueOrThrow({ where: { id }, select: { groupId: true } })).groupId),
      );
      await this.notifications.raise(tenantId, 'partner.job.direct', { type: 'job_assignment', id }, {
        product_name: label.productName,
        quantity: String(label.quantity),
      });
    }
  }

  /**
   * Offers the job to a partner that can take it, open until the workspace's deadline. Refused while
   * the job is offered or accepted already.
   */
  async offer(auth: TenantAuth, groupId: string, partnerId: string, dueOn?: string): Promise<JobAssignmentResponse> {
    const { row, job, expired } = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockOrderOfGroup(tx, groupId);
      await lockGroup(tx, groupId);
      await refuseWaiting(tx, groupId);
      // An offer past its deadline lets go of the job now, not when the minute run comes by.
      const expired = await this.expireLapsed(tx, { type: 'user', id: auth.userId }, groupId);
      await this.refuseOpen(tx, groupId);
      const settings = await this.settings.list(tx);
      const routing = settings['partners.routing'] as Routing | undefined;
      await this.keepWithOrder(tx, routing, groupId, partnerId);
      // The partner's room and open jobs are judged once at a time (Review Focus 1 of the fixes).
      await lockPartner(tx, partnerId);
      const { job, cost } = await this.able(tx, groupId, partnerId);
      const today = await workspaceToday(tx, auth.tenantId);
      if (dueOn !== undefined && dueOn < today) {
        throw new BadRequestException({ message: 'The due date is before today', errors: [{ path: 'due_on', message: `must be ${today} or later` }] });
      }
      const due = dueOn ?? (await defaultDueOn(tx, groupId, settings, today));
      const now = new Date();
      const created = await tx.jobAssignment.create({
        data: {
          groupId,
          partnerId,
          kind: 'offer',
          status: 'offered',
          cost,
          expiresAt: new Date(now.getTime() + (routing?.offerHours ?? DEFAULT_OFFER_HOURS) * HOUR_MS),
          dueOn: due ? asDate(due) : null,
          createdByUserId: auth.userId,
        },
        include,
      });
      await this.record(tx, auth.userId, created);
      return { row: created, job, expired };
    });
    // After commit: a notification never reports an offer that rolled back.
    await this.notifyExpired(auth.tenantId, expired);
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
    const { row, job } = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockOrderOfGroup(tx, groupId);
      await lockGroup(tx, groupId);
      await refuseWaiting(tx, groupId);
      const current = await tx.jobAssignment.findFirst({ where: { groupId, status: 'accepted' } });
      if (!current) {
        throw new ConflictException('Only a job a partner has accepted can be moved');
      }
      if (current.partnerId === input.partner_id) {
        throw new ConflictException('The job is already with this partner');
      }
      // Done work is paid, not moved: the new partner would be owed at once for work it never did.
      if (await jobPastPayout(tx, groupId)) {
        throw new ConflictException('Every piece is past the payout step: set what each partner is owed instead of moving the job');
      }
      await this.keepWithOrder(tx, await this.routing(tx), groupId, input.partner_id);
      await lockPartner(tx, input.partner_id);
      const { job, cost } = await this.able(tx, groupId, input.partner_id);
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
          dueOn: current.dueOn,
          createdByUserId: auth.userId,
        },
        include,
      });
      await this.record(tx, auth.userId, row);
      return { row, job };
    });
    // After commit: the partner the job moved to has it at once, so it hears of it.
    await this.notifications.raise(auth.tenantId, 'partner.job.reassigned', { type: 'job_assignment', id: row.id }, {
      product_name: job.productName,
      quantity: String(job.quantity),
    });
    return toAssignment(row);
  }

  /**
   * Expires the offers past their deadline, of one job or of every job, once each by a conditional
   * update, and audits each. Returns what to tell staff once the transaction has committed.
   */
  async expireLapsed(tx: Tx, actor: AuditInput['actor'], groupId?: string): Promise<ExpiredOffer[]> {
    const due = await tx.jobAssignment.findMany({
      where: { status: 'offered', expiresAt: { lte: new Date() }, ...(groupId ? { groupId } : {}) },
      select: { id: true },
    });
    const done: ExpiredOffer[] = [];
    for (const { id } of due) {
      const claimed = await tx.jobAssignment.updateMany({ where: { id, status: 'offered' }, data: { status: 'expired' } });
      if (claimed.count !== 1) continue;
      const row = await tx.jobAssignment.findUniqueOrThrow({ where: { id }, include });
      await this.audit.record(tx, { actor, action: 'partner.job', subject: { type: 'job_assignment', id }, after: toAssignment(row) });
      done.push({ id, partnerName: row.partner.name, job: await jobLabel(tx, row.groupId) });
    }
    return done;
  }

  /** Tells staff each job whose offer expired needs a partner again; after commit. */
  async notifyExpired(tenantId: string, expired: ExpiredOffer[]): Promise<void> {
    for (const offer of expired) {
      await this.notifications.raise(tenantId, 'partner.job.expired', { type: 'job_assignment', id: offer.id }, {
        partner_name: offer.partnerName,
        product_name: offer.job.productName,
        quantity: String(offer.job.quantity),
      });
    }
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

  /** What the partner is owed, per hand-over, newest first; another workspace's partner is not found. */
  async owed(tenantId: string, partnerId: string, query: PaginationQuery): Promise<PartnerOwedResponse> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      if (!(await tx.partner.findUnique({ where: { id: partnerId }, select: { id: true } }))) {
        throw new NotFoundException('Partner not found');
      }
      // The total covers every hand-over, so all are judged; the jobs and their pieces load in one query.
      const rows = await tx.jobAssignment.findMany({
        where: { partnerId, status: { in: OWED_STATUSES } },
        orderBy: { id: 'desc' },
      });
      const jobs = await owedJobs(tx, rows);
      const total = jobs
        .filter((job) => job.state === 'owed')
        .reduce((sum, job) => sum.plus(job.amount), new Prisma.Decimal(0));
      // Newest first by hand-over id, as the database orders uuids.
      const rest = after ? jobs.filter((job) => job.assignment_id < after.id) : jobs;
      const data = rest.slice(0, query.limit);
      const next_cursor = rest.length > query.limit ? encodeCursor({ id: data.at(-1)!.assignment_id }, secret) : null;
      return { total: total.toFixed(2), jobs: data, next_cursor };
    });
  }

  /**
   * What partners are owed now for these jobs: accepted ones whose every live piece has passed the
   * payout step (Payments, the refund suggestion). Work not that far yet counts as nothing.
   */
  async owedNow(tx: Tx, groupIds: string[]): Promise<Prisma.Decimal> {
    const rows = await tx.jobAssignment.findMany({ where: { groupId: { in: groupIds }, status: 'accepted' } });
    return (await owedJobs(tx, rows))
      .filter((job) => job.state === 'owed')
      .reduce((sum, job) => sum.plus(job.amount), new Prisma.Decimal(0));
  }

  /** Sets what the partner is owed for the job instead of its cost; the job must be or have been the partner's. */
  async setOwed(auth: TenantAuth, groupId: string, input: z.infer<typeof setOwedSchema>): Promise<OwedJobResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockGroup(tx, groupId);
      const current = await tx.jobAssignment.findFirst({
        where: { groupId, partnerId: input.partner_id, status: { in: OWED_STATUSES } },
        orderBy: { id: 'desc' },
      });
      if (!current) {
        throw new NotFoundException('The job was never with this partner');
      }
      const row = await tx.jobAssignment.update({
        where: { id: current.id },
        data: { owedOverride: input.amount, owedOverrideReason: input.reason },
        include,
      });
      await this.record(tx, auth.userId, row);
      return (await owedJobs(tx, [row]))[0];
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
      // A job of an order waiting for payment isn't there for any partner yet.
      if ((await waitingGroupIds(tx, [groupId])).size > 0) {
        throw new NotFoundException('Job not found');
      }
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

  private async routing(tx: Tx): Promise<Routing | undefined> {
    return (await this.settings.list(tx))['partners.routing'] as Routing | undefined;
  }

  /**
   * Unless the workspace lets one order's lines go to different partners, the job goes only to the
   * partner holding the order's other lines (Orders spec, goal 3). Under the order lock the caller holds.
   */
  private async keepWithOrder(tx: Tx, routing: Routing | undefined, groupId: string, partnerId: string): Promise<void> {
    // A workspace that never set it may split, as before the setting was enforced.
    if (routing?.splitOrderLines !== false) return;
    if ((await otherLinePartners(tx, groupId)).some((other) => other !== partnerId)) {
      throw new ConflictException(ONE_PARTNER);
    }
  }

  private async refuseOpen(tx: Tx, groupId: string): Promise<void> {
    if (await tx.jobAssignment.findFirst({ where: { groupId, ...liveOpen(new Date()) }, select: { id: true } })) {
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

/** Jobs with each piece and whether it has passed its workflow version's payout step. */
async function jobsWithPieces(tx: Tx, groupIds: string[]) {
  const groups = await tx.workOrderGroup.findMany({
    where: { id: { in: [...new Set(groupIds)] } },
    select: {
      id: true,
      quantity: true,
      product: { select: { name: true } },
      workflowVersion: { select: { payoutStepId: true, steps: { select: { id: true, position: true, doneBy: true } } } },
      workOrders: { select: { status: true, currentStep: { select: { position: true } } } },
    },
  });
  return new Map(
    groups.map((group) => {
      const { steps, payoutStepId: explicit } = group.workflowVersion;
      const payoutId = payoutStepId(steps, explicit);
      // A version without partner steps has no payout step: only finished pieces count as past it.
      const payoutPosition = steps.find((step) => step.id === payoutId)?.position ?? Number.POSITIVE_INFINITY;
      const pieces = group.workOrders.map((piece) => ({
        status: piece.status,
        passedPayout: passedPayout({ status: piece.status, stepPosition: piece.currentStep?.position ?? null }, payoutPosition),
      }));
      return [group.id, { ...group, pieces }];
    }),
  );
}

/** Every live piece of the job has passed the payout step. */
async function jobPastPayout(tx: Tx, groupId: string): Promise<boolean> {
  const { pieces } = (await jobsWithPieces(tx, [groupId])).get(groupId)!;
  const live = pieces.filter((piece) => piece.status === 'active' || piece.status === 'finished');
  return live.length > 0 && live.every((piece) => piece.passedPayout);
}

/** What each hand-over is owed, read from its job's pieces and its workflow version's payout step. */
async function owedJobs(tx: Tx, rows: JobAssignment[]): Promise<OwedJobResponse[]> {
  const byId = await jobsWithPieces(tx, rows.map((row) => row.groupId));
  return rows.flatMap((row) => {
    const group = byId.get(row.groupId)!;
    const owed = owedFor(row, group.pieces);
    if (!owed) return [];
    return [
      {
        assignment_id: row.id,
        group_id: row.groupId,
        product: group.product ? { name: group.product.name } : null,
        quantity: group.quantity,
        state: owed.state,
        amount: owed.amount.toFixed(2),
        override_reason: row.owedOverride !== null ? row.owedOverrideReason : null,
      },
    ];
  });
}

/** What a job's notifications name: never the customer. */
export interface JobLabel {
  productName: string;
  quantity: number;
}

/** An offer that just expired, for telling staff after commit. */
export interface ExpiredOffer {
  id: string;
  partnerName: string;
  job: JobLabel;
}

export async function jobLabel(tx: Tx, groupId: string): Promise<JobLabel> {
  const group = await tx.workOrderGroup.findUniqueOrThrow({
    where: { id: groupId },
    select: { quantity: true, product: { select: { name: true } } },
  });
  return { productName: group.product?.name ?? 'a job', quantity: group.quantity };
}
