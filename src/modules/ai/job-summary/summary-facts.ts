import type { Prisma } from '../../../generated/prisma/client';
import { DEFAULT_CLAIM_SETTINGS, reasonNamed } from '../../claims/claim-settings';
import type { ClaimSettings } from '../../claims/claim-settings';
import { localDate } from '../../orders/dates';
import { chosenOptions } from '../../partners/partner-jobs.service';
import type { SettingKey } from '../../settings/setting-keys';
import { pathFor } from '../../workflow/path';
import { chainOf, stepsForPath } from '../../workflow/work-orders.service';
import type { StepConfig } from '../../workflow/workflow-config';
import type { JobSummaryFacts } from './summary-prompt';

type Tx = Prisma.TransactionClient;

/** How far back the workshop's history and the workspace's findings are read. */
const HISTORY_DAYS = 365;
const DAY_MS = 86_400_000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value);
}

/** Counts by a label, most first, then by name. */
function counted<T extends string>(labels: T[]): { label: T; count: number }[] {
  const counts = new Map<T, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The facts a job's summary is written from (Orders 3 spec, goal 13), in the job's workspace. Reads the
 * job, the holding workshop's own transitions on its earlier jobs of the same product, and the
 * workspace's own fails and claims on that product as counts. Never selects a partner's or customer's
 * name, a price, a comment or a claim's description, and never another workshop's transitions.
 */
export async function jobSummaryFacts(tx: Tx, assignmentId: string, settings: Partial<Record<SettingKey, unknown>>): Promise<JobSummaryFacts> {
  const assignment = await tx.jobAssignment.findUniqueOrThrow({
    where: { id: assignmentId },
    select: { partnerId: true, dueOn: true, group: true },
  });
  const { group, partnerId } = assignment;
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: group.tenantId }, select: { timezone: true } });
  const product = group.productId ? await tx.product.findUnique({ where: { id: group.productId }, select: { name: true } }) : null;
  const options = (await chosenOptions(tx, [group])).get(group.id) ?? [];
  const measures = group.fileVersionId ? await tx.measure.findMany({ where: { fileVersionId: group.fileVersionId }, orderBy: { type: 'asc' } }) : [];

  const versionSteps = await tx.workflowStep.findMany({ where: { versionId: group.workflowVersionId }, include: { stepType: true } });
  const stepById = new Map(versionSteps.map((step) => [step.id, step]));
  const partnerSteps = pathFor(stepsForPath(versionSteps), chainOf(group))
    .map((id) => stepById.get(id)!)
    .filter((step) => step.doneBy === 'partner');

  const since = new Date(Date.now() - HISTORY_DAYS * DAY_MS);
  const sameProduct = group.productId ? { productId: group.productId, id: { not: group.id } } : { id: { in: [] as string[] } };

  // The workshop's own earlier jobs of the product: the groups it accepted, and its own moves on them.
  const ownJobs = await tx.workOrderGroup.findMany({
    where: { ...sameProduct, assignments: { some: { partnerId, status: { in: ['accepted', 'replaced', 'cancelled'] }, createdAt: { gte: since } } } },
    select: { id: true, quantity: true },
  });
  const ownGroupIds = ownJobs.map((job) => job.id);
  const scrapped = await tx.workOrder.count({ where: { groupId: { in: ownGroupIds }, status: 'scrapped' } });
  const ownMoves = await tx.transition.findMany({
    where: { partnerId, workOrder: { groupId: { in: ownGroupIds } } },
    orderBy: [{ workOrderId: 'asc' }, { createdAt: 'asc' }],
    select: {
      workOrderId: true,
      kind: true,
      fromStepId: true,
      toStepId: true,
      createdAt: true,
      fromStep: { select: { name: true, expectedMinutes: true } },
      defect: { select: { name: true } },
    },
  });
  // A step's minutes: from the move that brought a piece to it to the pass that took it on.
  const minutes = new Map<string, { values: number[]; expected: number | null }>();
  const arrived = new Map<string, Date>();
  for (const move of ownMoves) {
    if (move.kind === 'pass' && move.fromStepId && move.fromStep) {
      const from = arrived.get(`${move.workOrderId}:${move.fromStepId}`);
      const entry = minutes.get(move.fromStep.name) ?? { values: [], expected: move.fromStep.expectedMinutes ? Number(move.fromStep.expectedMinutes) : null };
      if (from) entry.values.push((move.createdAt.getTime() - from.getTime()) / 60_000);
      minutes.set(move.fromStep.name, entry);
    }
    if (move.toStepId) arrived.set(`${move.workOrderId}:${move.toStepId}`, move.createdAt);
  }
  const ownDefects = counted(ownMoves.flatMap((move) => (move.kind === 'fail' && move.defect ? [move.defect.name] : [])));

  // The workspace's own findings on the product: fails at its own steps, never a workshop's, and claims.
  const workspaceFails = await tx.transition.findMany({
    where: {
      kind: 'fail',
      partnerId: null,
      defectId: { not: null },
      createdAt: { gte: since },
      fromStep: { doneBy: 'workspace' },
      workOrder: { group: sameProduct },
    },
    select: { fromStep: { select: { name: true } }, defect: { select: { name: true } } },
  });
  const failCounts = counted(workspaceFails.map((fail) => `${fail.fromStep!.name}\u0000${fail.defect!.name}`));
  const claimSettings = (settings['orders.claims'] as ClaimSettings | undefined) ?? DEFAULT_CLAIM_SETTINGS;
  const claimed = group.productId
    ? await tx.claimLine.findMany({
        where: { orderLine: { productId: group.productId }, claim: { createdAt: { gte: since } } },
        select: { pieces: true, claim: { select: { reason: true } } },
      })
    : [];
  const claimPieces = new Map<string, number>();
  for (const line of claimed) {
    const reason = reasonNamed(line.claim.reason, claimSettings).name;
    claimPieces.set(reason, (claimPieces.get(reason) ?? 0) + line.pieces);
  }

  return {
    job: {
      product: product?.name ?? 'Job',
      options,
      quantity: group.quantity,
      measures: measures.length > 0 ? Object.fromEntries(measures.map((measure) => [measure.type, `${measure.value.toString()} ${measure.unit}`])) : null,
      due_on: assignment.dueOn?.toISOString().slice(0, 10) ?? null,
      today: localDate(new Date(), tenant.timezone),
      steps: partnerSteps.map((step) => ({ name: step.name, checklist: ((step.config as StepConfig).checklist ?? []).map((item) => item.label) })),
    },
    own_history: {
      jobs: ownJobs.length,
      pieces: ownJobs.reduce((sum, job) => sum + job.quantity, 0),
      scrapped,
      steps: [...minutes.entries()].map(([name, entry]) => ({ name, median_minutes: median(entry.values), expected_minutes: entry.expected })),
      defects: ownDefects.map(({ label, count }) => ({ defect: label, count })),
    },
    workspace_findings: {
      defects: failCounts.map(({ label, count }) => {
        const [step, defect] = label.split('\u0000');
        return { step, defect, count };
      }),
      claims: [...claimPieces.entries()].map(([reason, pieces]) => ({ reason, pieces })).sort((a, b) => b.pieces - a.pieces),
    },
  };
}
