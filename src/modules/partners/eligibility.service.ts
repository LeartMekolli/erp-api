import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { WorkOrderGroup } from '../../generated/prisma/client';
import { QuotesService } from '../pricing/quotes.service';
import { pathFor } from '../workflow/path';
import { chainOf, stepsForPath } from '../workflow/work-orders.service';
import { eligible } from './eligibility';
import type { JobFacts, PartnerFacts } from './eligibility';
import type { EligiblePartnersResponse } from './partner-response';

/** Offers and jobs that hold a partner's capacity. */
export const OPEN_STATUSES = ['offered', 'accepted'];

/** A job as eligibility sees it: a work order group started from a quote. */
export interface Job {
  group: WorkOrderGroup;
  quoteId: string;
  /** The quote's total: what the customer pays. */
  total: Prisma.Decimal;
  facts: JobFacts;
  /** The step types of the partner's steps, once each, in path order, with their keys. */
  partnerSteps: { stepTypeId: string; key: string }[];
}

export type Verdict =
  | { ok: true; cost: Prisma.Decimal; left: Map<string, number> }
  | { ok: false; reasons: string[] };

type Tx = Prisma.TransactionClient;

/** The step ids of a group's path, from its workflow version's steps (Workflow/QC F12). */
async function pathsOf(tx: Tx, groups: WorkOrderGroup[]) {
  const steps = await tx.workflowStep.findMany({
    where: { versionId: { in: [...new Set(groups.map((group) => group.workflowVersionId))] } },
    include: { stepType: true },
  });
  return { steps, path: (group: WorkOrderGroup) => pathFor(stepsForPath(steps.filter((step) => step.versionId === group.workflowVersionId)), chainOf(group)) };
}

/**
 * Who can take a job (Partners spec, goal 9): the facts of the job and of each partner, read from
 * the rows, and judged by `eligible`. A partner that passes is costed with its own prices.
 */
@Injectable()
export class EligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotes: QuotesService,
  ) {}

  /** Staff only: every partner that can take the job, cheapest first, and every one that can't, with why. */
  async list(tenantId: string, groupId: string): Promise<EligiblePartnersResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const job = await this.job(tx, groupId);
      const partners = await tx.partner.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true, name: true } });
      const verdicts = await this.judge(tx, job, partners.map((partner) => partner.id));

      const data: EligiblePartnersResponse['data'] = [];
      const ineligible: EligiblePartnersResponse['ineligible'] = [];
      for (const partner of partners) {
        const verdict = verdicts.get(partner.id)!;
        if (!verdict.ok) {
          ineligible.push({ partner, reasons: verdict.reasons });
          continue;
        }
        data.push({
          partner,
          cost: verdict.cost.toFixed(2),
          margin: job.total.minus(verdict.cost).toFixed(2),
          room: job.partnerSteps.map((step) => ({ step_key: step.key, left: verdict.left.get(step.stepTypeId) ?? 0 })),
          score: null,
        });
      }
      // Cheapest first; partners are already in name order, and the sort is stable.
      data.sort((a, b) => new Prisma.Decimal(a.cost).comparedTo(b.cost));
      return { data, ineligible };
    });
  }

  /** The job behind a work order group; another workspace's group is not found. */
  async job(tx: Tx, groupId: string): Promise<Job> {
    const group = await tx.workOrderGroup.findUnique({ where: { id: groupId } });
    if (!group) {
      throw new NotFoundException('Job not found');
    }
    if (group.sourceType !== 'quote') {
      throw new ConflictException('Only jobs started from a quote can go to a partner for now');
    }
    const quote = await tx.quote.findUniqueOrThrow({ where: { id: group.sourceId } });

    const { steps, path } = await pathsOf(tx, [group]);
    const byId = new Map(steps.map((step) => [step.id, step]));
    const partnerSteps: Job['partnerSteps'] = [];
    const priced = new Set<string>();
    for (const id of path(group)) {
      const step = byId.get(id)!;
      if (step.doneBy !== 'partner') continue;
      if (step.priced) priced.add(step.stepTypeId);
      if (!partnerSteps.some((one) => one.stepTypeId === step.stepTypeId)) {
        partnerSteps.push({ stepTypeId: step.stepTypeId, key: step.stepType.key });
      }
    }

    // The chosen values, by group and value key; keys never change.
    const options = Object.entries((quote.inputs as { options: Record<string, string> }).options);
    const values = await tx.optionValue.findMany({
      where: { OR: options.map(([groupKey, key]) => ({ key, group: { key: groupKey } })) },
      include: { group: { select: { key: true } } },
    });
    const valueIds = options.flatMap(([groupKey, key]) =>
      values.filter((value) => value.group.key === groupKey && value.key === key).map((value) => value.id),
    );

    // The quote's measures are at the chosen size, in mm.
    const sides = (quote.breakdown as { measures: { type: string; value: string }[] }).measures
      .filter((measure) => measure.type.startsWith('bounding_box_'))
      .map((measure) => new Prisma.Decimal(measure.value));
    const largestSideMm = sides.length > 0 ? Prisma.Decimal.max(...sides) : null;

    return {
      group,
      quoteId: quote.id,
      total: quote.total,
      partnerSteps,
      facts: {
        quantity: group.quantity,
        partnerStepTypeIds: new Set(partnerSteps.map((step) => step.stepTypeId)),
        pricedStepTypeIds: priced,
        optionValueIds: valueIds,
        largestSideMm,
        names: new Map([
          ...partnerSteps.map((step) => [step.stepTypeId, step.key] as const),
          ...values.map((value) => [value.id, value.key] as const),
        ]),
      },
    };
  }

  /**
   * Judges each partner for the job, today. The job's own offer or assignment never counts against
   * the room it needs, so a job can be judged again while it is being moved.
   */
  async judge(tx: Tx, job: Job, partnerIds: string[]): Promise<Map<string, Verdict>> {
    const facts = await this.partnerFacts(tx, partnerIds, job.group.id);
    const verdicts = new Map<string, Verdict>();
    const now = new Date();
    for (const partnerId of partnerIds) {
      const partner = facts.get(partnerId);
      if (!partner) {
        throw new NotFoundException('Partner not found');
      }
      const verdict = eligible(job.facts, partner, now);
      if (!verdict.ok) {
        verdicts.set(partnerId, verdict);
        continue;
      }
      const priced = await this.quotes.costFor(tx, job.quoteId, partnerId);
      verdicts.set(
        partnerId,
        priced.cost === null ? { ok: false, reasons: priced.refusals.map((refusal) => refusal.message) } : { ok: true, cost: priced.cost, left: verdict.left },
      );
    }
    return verdicts;
  }

  /** Each partner's setup, and what its other open jobs hold: pieces still to go through each step type. */
  private async partnerFacts(tx: Tx, partnerIds: string[], exceptGroupId: string): Promise<Map<string, PartnerFacts>> {
    const partners = await tx.partner.findMany({
      where: { id: { in: partnerIds } },
      include: {
        capabilities: true,
        offerings: { select: { optionValueId: true } },
        closedPeriods: true,
        stepPrices: { select: { stepTypeId: true } },
      },
    });
    const open = await tx.jobAssignment.findMany({
      where: { partnerId: { in: partnerIds }, status: { in: OPEN_STATUSES }, groupId: { not: exceptGroupId } },
      include: { group: true },
    });
    const groups = [...new Map(open.map((row) => [row.groupId, row.group])).values()];
    const { steps, path } = await pathsOf(tx, groups);
    const typeOf = new Map(steps.map((step) => [step.id, step.stepTypeId]));
    const pieces = await tx.workOrder.findMany({
      where: { groupId: { in: groups.map((group) => group.id) }, status: 'active' },
      select: { groupId: true, currentStepId: true },
    });

    // By group: pieces still to go through each step type.
    const ahead = new Map<string, Map<string, number>>();
    for (const group of groups) {
      const ids = path(group);
      const counts = new Map<string, number>();
      for (const piece of pieces.filter((one) => one.groupId === group.id)) {
        const from = piece.currentStepId ? ids.indexOf(piece.currentStepId) : -1;
        if (from < 0) continue;
        for (const stepTypeId of new Set(ids.slice(from).map((id) => typeOf.get(id)!))) {
          counts.set(stepTypeId, (counts.get(stepTypeId) ?? 0) + 1);
        }
      }
      ahead.set(group.id, counts);
    }

    const date = (value: Date) => value.toISOString().slice(0, 10);
    return new Map(
      partners.map((partner) => {
        const mine = open.filter((row) => row.partnerId === partner.id);
        const load = new Map<string, number>();
        let openJobs = 0;
        for (const row of mine) {
          const counts = ahead.get(row.groupId)!;
          if (counts.size > 0) openJobs += 1;
          for (const [stepTypeId, count] of counts) load.set(stepTypeId, (load.get(stepTypeId) ?? 0) + count);
        }
        return [
          partner.id,
          {
            status: partner.status,
            capabilities: partner.capabilities.map((capability) => ({
              stepTypeId: capability.stepTypeId,
              minQuantity: capability.minQuantity,
              maxQuantity: capability.maxQuantity,
              maxSizeMm: capability.maxSizeMm,
              capacity: capability.capacity,
            })),
            offeredValueIds: new Set(partner.offerings.map((offering) => offering.optionValueId)),
            closedPeriods: partner.closedPeriods.map((period) => ({ startsOn: date(period.startsOn), endsOn: date(period.endsOn) })),
            openJobs,
            maxOpenJobs: partner.maxOpenJobs,
            pricedStepTypeIds: new Set(partner.stepPrices.map((price) => price.stepTypeId)),
            load,
          },
        ];
      }),
    );
  }
}
