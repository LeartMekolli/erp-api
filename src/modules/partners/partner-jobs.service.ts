import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { JobAssignment, Prisma } from '../../generated/prisma/client';
import { FilesService } from '../files/files.service';
import type { PartnerAuth } from '../identity/auth-context';
import { pathFor } from '../workflow/path';
import { chainOf, stepsForPath } from '../workflow/work-orders.service';
import { PARTNER_JOB_STATUSES } from './partner-response';
import type { PartnerJobDetailResponse, PartnerJobResponse } from './partner-response';

export const partnerJobsQuerySchema = z.object({ status: z.enum(PARTNER_JOB_STATUSES).optional() });

type Tx = Prisma.TransactionClient;

/** Jobs the partner is offered or has accepted: its current row of each, newest job first. */
const OPEN = ['offered', 'accepted'];

/**
 * A partner's jobs, as its people see them (Partners spec, goal 13): only jobs offered to or accepted
 * by the partner, and only what it needs to make them. The quote is read for the chosen options, and
 * nothing of it is passed on.
 */
@Injectable()
export class PartnerJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async list(auth: PartnerAuth, status: PartnerJobResponse['status'] | undefined): Promise<{ data: PartnerJobResponse[] }> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const rows = await tx.jobAssignment.findMany({
        where: { partnerId: auth.partnerId, status: { in: OPEN } },
        orderBy: { groupId: 'desc' },
      });
      const jobs: PartnerJobResponse[] = [];
      for (const row of rows) {
        const job = await this.view(tx, row);
        if (!status || job.status === status) jobs.push(job);
      }
      return { data: jobs };
    });
  }

  async detail(auth: PartnerAuth, groupId: string): Promise<PartnerJobDetailResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const job = await this.view(tx, await this.find(tx, auth, groupId));
      const group = await tx.workOrderGroup.findUniqueOrThrow({ where: { id: groupId }, select: { quantity: true } });
      const pieces = await tx.workOrder.findMany({
        where: { groupId, status: { not: 'cancelled' } },
        orderBy: { id: 'asc' },
        include: { currentStep: { select: { key: true } } },
      });
      return {
        ...job,
        work_orders: pieces.map((piece) => ({
          id: piece.id,
          label: `${piece.number}/${group.quantity}`,
          status: piece.status as PartnerJobDetailResponse['work_orders'][number]['status'],
          step_key: piece.currentStep?.key ?? null,
        })),
      };
    });
  }

  /** A short-lived link to the job's design file. */
  async design(auth: PartnerAuth, groupId: string): Promise<{ url: string; expires_at: string }> {
    const version = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.find(tx, auth, groupId);
      const group = await tx.workOrderGroup.findUniqueOrThrow({
        where: { id: groupId },
        select: { fileVersion: { select: { id: true, fileId: true } } },
      });
      return group.fileVersion;
    });
    if (!version) {
      throw new NotFoundException('The job has no design file');
    }
    return this.files.downloadUrl(auth.tenantId, version.fileId, version.id);
  }

  /** The partner's current row of the job; another partner's job, or one it declined or lost, is not found. */
  private async find(tx: Tx, auth: PartnerAuth, groupId: string): Promise<JobAssignment> {
    const row = await tx.jobAssignment.findFirst({ where: { groupId, partnerId: auth.partnerId, status: { in: OPEN } } });
    if (!row) {
      throw new NotFoundException('Job not found');
    }
    return row;
  }

  private async view(tx: Tx, row: JobAssignment): Promise<PartnerJobResponse> {
    const group = await tx.workOrderGroup.findUniqueOrThrow({
      where: { id: row.groupId },
      include: { product: { select: { name: true } } },
    });

    const steps = await tx.workflowStep.findMany({ where: { versionId: group.workflowVersionId }, include: { stepType: true } });
    const byId = new Map(steps.map((step) => [step.id, step]));
    const partnerSteps = pathFor(stepsForPath(steps), chainOf(group))
      .map((id) => byId.get(id)!)
      .filter((step) => step.doneBy === 'partner');

    const counts = await tx.workOrder.groupBy({ by: ['status'], where: { groupId: group.id }, _count: { _all: true } });
    const count = (status: string) => counts.find((one) => one.status === status)?._count._all ?? 0;
    const active = count('active');

    return {
      id: group.id,
      status: row.status === 'offered' ? 'offered' : active > 0 ? 'accepted' : 'finished',
      offered_at: row.createdAt.toISOString(),
      expires_at: row.expiresAt?.toISOString() ?? null,
      product: group.product ? { name: group.product.name } : null,
      options: await this.options(tx, group.sourceType === 'quote' ? group.sourceId : null, group.productId),
      quantity: group.quantity,
      design_file_version_id: group.fileVersionId,
      steps: partnerSteps.map((step) => ({ key: step.key, name: step.name, sop_file_version_id: step.sopFileVersionId })),
      cost: row.cost.toFixed(2),
      pieces: { active, finished: count('finished'), scrapped: count('scrapped') },
    };
  }

  /**
   * The chosen options by name, from the quote's inputs (keys never change), in the product's option
   * order: stored JSON keeps no key order.
   */
  private async options(tx: Tx, quoteId: string | null, productId: string | null): Promise<PartnerJobResponse['options']> {
    if (!quoteId) return [];
    const quote = await tx.quote.findUniqueOrThrow({ where: { id: quoteId }, select: { inputs: true } });
    const chosen = Object.entries((quote.inputs as { options: Record<string, string> }).options);
    if (chosen.length === 0) return [];
    const values = await tx.optionValue.findMany({
      where: { OR: chosen.map(([groupKey, key]) => ({ key, group: { key: groupKey } })) },
      include: { group: { select: { id: true, key: true, name: true } } },
    });
    const positions = productId
      ? await tx.productOptionGroup.findMany({ where: { productId }, select: { groupId: true, position: true } })
      : [];
    const positionOf = (groupId: string) => positions.find((one) => one.groupId === groupId)?.position ?? Number.MAX_SAFE_INTEGER;
    return chosen
      .flatMap(([groupKey, key]) => values.filter((one) => one.group.key === groupKey && one.key === key))
      .sort((a, b) => positionOf(a.group.id) - positionOf(b.group.id) || a.group.key.localeCompare(b.group.key))
      .map((value) => ({ group: value.group.name, value: value.name }));
  }
}
