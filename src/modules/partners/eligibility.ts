import type { Prisma } from '../../generated/prisma/client';

/** What a job needs from a partner (Partners spec, goal 9). */
export interface JobFacts {
  quantity: number;
  /** The step types of the partner's steps on the job's path. */
  partnerStepTypeIds: Set<string>;
  /** Of those, the ones that are priced: the partner needs a price for each. */
  pricedStepTypeIds: Set<string>;
  /** The job's chosen option values, in option order. */
  optionValueIds: string[];
  /** The largest bounding-box side of a piece, in mm; null when the job has no measured design. */
  largestSideMm: Prisma.Decimal | null;
  /** Keys of the step types and option values above, for the reasons. */
  names: Map<string, string>;
}

export interface CapabilityFacts {
  stepTypeId: string;
  minQuantity: number;
  maxQuantity: number | null;
  maxSizeMm: Prisma.Decimal | null;
  /** Pieces per capacity period. */
  capacity: number;
}

/** What a partner offers, and what it already holds. */
export interface PartnerFacts {
  status: string;
  capabilities: CapabilityFacts[];
  offeredValueIds: Set<string>;
  /** ISO dates, both included. */
  closedPeriods: { startsOn: string; endsOn: string }[];
  /** Jobs offered to it or accepted by it, with pieces still in production. */
  openJobs: number;
  maxOpenJobs: number | null;
  /** Step types it has a price for. */
  pricedStepTypeIds: Set<string>;
  /** By step type: pieces of its open jobs that still have that step ahead of them. */
  load: Map<string, number>;
}

/**
 * Whether the job fits the partner's capacity at each of `steps`: what it already holds plus the job
 * stays within one period's capacity (goal 5). `left` is what would remain, negative when it doesn't fit.
 */
export function roomFor(
  capabilities: { stepTypeId: string; capacity: number }[],
  load: Map<string, number>,
  quantity: number,
  steps: Set<string>,
): { ok: boolean; left: Map<string, number> } {
  const left = new Map<string, number>();
  for (const capability of capabilities) {
    if (!steps.has(capability.stepTypeId)) continue;
    left.set(capability.stepTypeId, capability.capacity - (load.get(capability.stepTypeId) ?? 0) - quantity);
  }
  return { ok: [...left.values()].every((value) => value >= 0), left };
}

/**
 * Whether the partner can take the job today, and if not, every reason why, in plain words for staff
 * (goal 9). The job's cost with the partner is checked by the caller, which has the prices.
 */
export function eligible(
  job: JobFacts,
  partner: PartnerFacts,
  today: Date,
): { ok: true; left: Map<string, number> } | { ok: false; reasons: string[] } {
  const name = (id: string) => job.names.get(id) ?? id;
  const reasons: string[] = [];

  // Nothing for a partner to do: the job is the workspace's own (P17).
  if (job.partnerStepTypeIds.size === 0) {
    return { ok: false, reasons: ['The job has no partner steps; make it in-house'] };
  }

  if (partner.status === 'suspended') reasons.push('The partner is suspended');
  else if (partner.status !== 'approved') reasons.push('The partner is not approved yet');

  const byStep = new Map(partner.capabilities.map((capability) => [capability.stepTypeId, capability]));
  const able: CapabilityFacts[] = [];
  for (const stepTypeId of job.partnerStepTypeIds) {
    const capability = byStep.get(stepTypeId);
    if (!capability) {
      reasons.push(`No capability for ${name(stepTypeId)}`);
      continue;
    }
    able.push(capability);
  }
  for (const capability of able) {
    const step = name(capability.stepTypeId);
    if (job.quantity < capability.minQuantity) {
      reasons.push(`${step} takes at least ${capability.minQuantity} pieces per job; the job has ${job.quantity}`);
    }
    if (capability.maxQuantity !== null && job.quantity > capability.maxQuantity) {
      reasons.push(`${step} takes at most ${capability.maxQuantity} pieces per job; the job has ${job.quantity}`);
    }
    if (capability.maxSizeMm !== null && job.largestSideMm !== null && job.largestSideMm.greaterThan(capability.maxSizeMm)) {
      reasons.push(`${step} takes pieces up to ${capability.maxSizeMm.toFixed()} mm; the largest side is ${job.largestSideMm.toFixed()} mm`);
    }
  }

  const notOffered = job.optionValueIds.filter((id) => !partner.offeredValueIds.has(id));
  if (notOffered.length > 0) reasons.push(`Does not offer ${notOffered.map(name).join(', ')}`);

  const room = roomFor(able, partner.load, job.quantity, job.partnerStepTypeIds);
  for (const capability of able) {
    if ((room.left.get(capability.stepTypeId) ?? 0) < 0) {
      const taken = partner.load.get(capability.stepTypeId) ?? 0;
      reasons.push(
        `No room for ${name(capability.stepTypeId)}: ${capability.capacity} pieces a period, ${taken} taken, the job needs ${job.quantity}`,
      );
    }
  }

  const day = today.toISOString().slice(0, 10);
  const closed = partner.closedPeriods.find((period) => period.startsOn <= day && day <= period.endsOn);
  if (closed) reasons.push(`Closed today (${closed.startsOn} to ${closed.endsOn})`);

  if (partner.maxOpenJobs !== null && partner.openJobs >= partner.maxOpenJobs) {
    reasons.push(`Already has ${partner.openJobs} open jobs, its limit`);
  }

  const unpriced = [...job.pricedStepTypeIds].filter((id) => !partner.pricedStepTypeIds.has(id));
  if (unpriced.length > 0) reasons.push(`No price for ${unpriced.map(name).join(', ')}`);

  return reasons.length === 0 ? { ok: true, left: room.left } : { ok: false, reasons };
}
