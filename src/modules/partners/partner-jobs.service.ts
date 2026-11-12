import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import { paginationQuerySchema, toPage } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { JobAssignment, Prisma, WorkOrderGroup } from '../../generated/prisma/client';
import { FilesService } from '../files/files.service';
import type { PartnerAuth } from '../identity/auth-context';
import { notWaitingForPayment } from '../orders/payment-hold';
import type { WorkflowStepRow } from '../workflow/coverage';
import { pathFor } from '../workflow/path';
import { toInspect } from '../workflow/sampling';
import type { StepConfig } from '../workflow/workflow-config';
import { chainOf, stepsForPath } from '../workflow/work-orders.service';
import { jobSummaryOf } from './job-summary-response';
import { PARTNER_JOB_STATUSES } from './partner-response';
import type { PartnerJobDetailResponse, PartnerJobResponse, PartnerStepRules } from './partner-response';

export const partnerJobsQuerySchema = paginationQuerySchema.extend({ status: z.enum(PARTNER_JOB_STATUSES).optional() });
export type PartnerJobsQuery = z.infer<typeof partnerJobsQuerySchema>;

type Tx = Prisma.TransactionClient;
type PartnerJobStatus = PartnerJobResponse['status'];

/** Jobs the partner is offered or has accepted: its current row of each. */
const OPEN = ['offered', 'accepted'];

/** The partner's rows of the jobs in one status, decided in the query so a page is never short. */
function statusWhere(status: PartnerJobStatus | undefined): Prisma.JobAssignmentWhereInput {
  switch (status) {
    case 'offered':
      return { status: 'offered' };
    case 'accepted':
      return { status: 'accepted', group: { workOrders: { some: { status: 'active' } } } };
    case 'finished':
      return { status: 'accepted', group: { workOrders: { none: { status: 'active' } } } };
    default:
      return { status: { in: OPEN } };
  }
}

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
    private readonly config: ConfigService,
  ) {}

  /** Newest hand-over first, a page at a time; each page is read in a fixed number of queries. */
  async list(auth: PartnerAuth, query: PartnerJobsQuery): Promise<Page<PartnerJobResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const rows = await tx.jobAssignment.findMany({
        where: {
          partnerId: auth.partnerId,
          ...statusWhere(query.status),
          ...(after ? { id: { lt: after.id } } : {}),
          AND: [{ group: notWaitingForPayment }],
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const page = toPage(rows, query.limit, secret);
      return { data: await this.views(tx, page.data), next_cursor: page.next_cursor };
    });
  }

  async detail(auth: PartnerAuth, groupId: string): Promise<PartnerJobDetailResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const [job] = await this.views(tx, [await this.find(tx, auth, groupId, OPEN)]);
      const group = await tx.workOrderGroup.findUniqueOrThrow({ where: { id: groupId } });
      const pieces = await tx.workOrder.findMany({
        where: { groupId, status: { not: 'cancelled' } },
        orderBy: { id: 'asc' },
        include: { currentStep: { select: { key: true } } },
      });
      const steps = await versionSteps(tx, group);
      // Only at the partner's own steps: whether the workspace samples at its steps stays with staff.
      const mine = new Set(partnerPath(steps, group).map((step) => step.id));
      const inspect = await toInspect(tx, pieces.filter((piece) => piece.currentStepId !== null && mine.has(piece.currentStepId)));
      return {
        ...job,
        steps: await stepRules(tx, steps, group),
        work_orders: pieces.map((piece) => ({
          id: piece.id,
          label: `${piece.number}/${group.quantity}`,
          status: piece.status as PartnerJobDetailResponse['work_orders'][number]['status'],
          step_key: piece.currentStep?.key ?? null,
          to_inspect: inspect.get(piece.id) ?? null,
        })),
        summary: await jobSummaryOf(tx, groupId),
      };
    });
  }

  /** A short-lived link to the instructions of one of the partner's steps on a job it has accepted. */
  async sop(auth: PartnerAuth, groupId: string, stepKey: string): Promise<{ url: string; expires_at: string }> {
    const version = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.find(tx, auth, groupId, ['accepted']);
      const group = await tx.workOrderGroup.findUniqueOrThrow({ where: { id: groupId } });
      const step = partnerPath(await versionSteps(tx, group), group).find((one) => one.key === stepKey);
      if (!step?.sopFileVersionId) return null;
      return tx.fileVersion.findUniqueOrThrow({ where: { id: step.sopFileVersionId }, select: { id: true, fileId: true } });
    });
    if (!version) {
      throw new NotFoundException('Step instructions not found');
    }
    return this.files.downloadUrl(auth.tenantId, version.fileId, version.id);
  }

  /** A short-lived link to the job's design file; only once the partner has accepted the job. */
  async design(auth: PartnerAuth, groupId: string): Promise<{ url: string; expires_at: string }> {
    const version = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.find(tx, auth, groupId, ['accepted']);
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

  /**
   * The partner's current row of the job; another partner's job, one it declined or lost, or one of
   * an order waiting for payment, is not found.
   */
  private async find(tx: Tx, auth: PartnerAuth, groupId: string, statuses: string[]): Promise<JobAssignment> {
    const row = await tx.jobAssignment.findFirst({
      where: { groupId, partnerId: auth.partnerId, status: { in: statuses }, group: notWaitingForPayment },
    });
    if (!row) {
      throw new NotFoundException('Job not found');
    }
    return row;
  }

  /** The jobs of `rows`, in their order, read with one query per kind of fact. */
  private async views(tx: Tx, rows: JobAssignment[]): Promise<PartnerJobResponse[]> {
    if (rows.length === 0) return [];
    const groups = await tx.workOrderGroup.findMany({
      where: { id: { in: rows.map((row) => row.groupId) } },
      include: { product: { select: { name: true } } },
    });
    const groupById = new Map(groups.map((group) => [group.id, group]));
    const steps = await tx.workflowStep.findMany({
      where: { versionId: { in: [...new Set(groups.map((group) => group.workflowVersionId))] } },
      include: { stepType: true },
    });
    const counts = await tx.workOrder.groupBy({
      by: ['groupId', 'status'],
      where: { groupId: { in: groups.map((group) => group.id) } },
      _count: { _all: true },
    });
    const options = await chosenOptions(tx, groups);

    return rows.map((row) => {
      const group = groupById.get(row.groupId)!;
      const partnerSteps = partnerPath(steps.filter((step) => step.versionId === group.workflowVersionId), group);
      const count = (status: string) => counts.find((one) => one.groupId === group.id && one.status === status)?._count._all ?? 0;
      const active = count('active');
      return {
        id: group.id,
        status: row.status === 'offered' ? 'offered' : active > 0 ? 'accepted' : 'finished',
        offered_at: row.createdAt.toISOString(),
        expires_at: row.expiresAt?.toISOString() ?? null,
        due_on: row.dueOn?.toISOString().slice(0, 10) ?? null,
        product: group.product ? { name: group.product.name } : null,
        options: options.get(group.id) ?? [],
        quantity: group.quantity,
        design_file_version_id: group.fileVersionId,
        steps: partnerSteps.map((step) => ({ key: step.key, name: step.name, sop_file_version_id: step.sopFileVersionId })),
        cost: row.cost.toFixed(2),
        pieces: { active, finished: count('finished'), scrapped: count('scrapped') },
      };
    });
  }
}

/** The steps of the group's workflow version. */
function versionSteps(tx: Tx, group: WorkOrderGroup): Promise<WorkflowStepRow[]> {
  return tx.workflowStep.findMany({ where: { versionId: group.workflowVersionId }, include: { stepType: true } });
}

/** The partner's steps on the group's path, in path order; `steps` are those of the group's version. */
function partnerPath(steps: WorkflowStepRow[], group: WorkOrderGroup): WorkflowStepRow[] {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  return pathFor(stepsForPath(steps), chainOf(group))
    .map((id) => stepById.get(id)!)
    .filter((step) => step.doneBy === 'partner');
}

/**
 * What the QC gate asks for at each of the partner's steps on the group's path. A rework target the
 * workspace does is named, nothing more.
 */
async function stepRules(tx: Tx, steps: WorkflowStepRow[], group: WorkOrderGroup): Promise<PartnerStepRules[]> {
  const mine = partnerPath(steps, group).map((step) => ({ step, config: step.config as StepConfig }));
  const defectIds = [...new Set(mine.flatMap(({ config }) => config.defects.map((defect) => defect.defect_id)))];
  const defects = new Map(
    (await tx.defect.findMany({ where: { id: { in: defectIds } }, select: { id: true, key: true, name: true } })).map((row) => [row.id, row]),
  );
  const nameOf = new Map(steps.map((step) => [step.key, step.name]));
  return mine.map(({ step, config }) => ({
    key: step.key,
    name: step.name,
    sop_file_version_id: step.sopFileVersionId,
    checklist: config.checklist,
    defects: config.defects.map((defect) => ({
      id: defect.defect_id,
      key: defects.get(defect.defect_id)!.key,
      name: defects.get(defect.defect_id)!.name,
      outcome: defect.outcome,
      rework_to: defect.rework_to ?? null,
    })),
    rework_targets: config.rework_targets.map((key) => ({ key, name: nameOf.get(key) ?? key })),
    pass: config.pass,
    fail: config.fail,
    sampling: config.sampling ?? null,
  }));
}

/**
 * Each job's chosen options by name, from its quote's inputs (keys never change), in its product's
 * option order: stored JSON keeps no key order. Also read by the job summary.
 */
export async function chosenOptions(
  tx: Tx,
  groups: { id: string; quoteId: string | null; productId: string | null }[],
): Promise<Map<string, PartnerJobResponse['options']>> {
  // Started from a quote or from an order line, a job knows the quote it was priced by.
  const fromQuotes = groups.filter((group): group is typeof group & { quoteId: string } => group.quoteId !== null);
  const quotes = await tx.quote.findMany({ where: { id: { in: fromQuotes.map((group) => group.quoteId) } }, select: { id: true, inputs: true } });
  const chosenOf = new Map(
    quotes.map((quote) => [quote.id, Object.entries((quote.inputs as { options: Record<string, string> }).options)]),
  );
  const pairs = [...chosenOf.values()].flat();
  if (pairs.length === 0) return new Map();
  const values = await tx.optionValue.findMany({
    where: { OR: pairs.map(([groupKey, key]) => ({ key, group: { key: groupKey } })) },
    include: { group: { select: { id: true, key: true, name: true } } },
  });
  const productIds = [...new Set(fromQuotes.flatMap((group) => (group.productId ? [group.productId] : [])))];
  const positions = await tx.productOptionGroup.findMany({
    where: { productId: { in: productIds } },
    select: { productId: true, groupId: true, position: true },
  });

  return new Map(
    fromQuotes.map((group) => {
      const positionOf = (groupId: string) =>
        positions.find((one) => one.productId === group.productId && one.groupId === groupId)?.position ?? Number.MAX_SAFE_INTEGER;
      const chosen = chosenOf.get(group.quoteId) ?? [];
      const named = chosen
        .flatMap(([groupKey, key]) => values.filter((one) => one.group.key === groupKey && one.key === key))
        .sort((a, b) => positionOf(a.group.id) - positionOf(b.group.id) || a.group.key.localeCompare(b.group.key))
        .map((value) => ({ group: value.group.name, value: value.name }));
      return [group.id, named];
    }),
  );
}
