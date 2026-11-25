import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { localDate } from '../orders/dates';
import { heldSkillIds, isOwner } from '../users/skills.service';
import type { StepConfig } from './workflow-config';

// Who may pass or fail pieces at a step that requires a skill (Workflow 2 spec, goals 11–13): staff
// holding the skill on the workspace's today, and the owner always, so nobody is locked out.

type Caller = { tenantId: string; userId: string };

/** The skills the caller may count on today; null for the owner, who may work every step. */
async function skillsOf(tx: Prisma.TransactionClient, caller: Caller): Promise<Set<string> | null> {
  if (await isOwner(tx, caller.userId)) {
    return null;
  }
  const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: caller.tenantId }, select: { timezone: true } });
  return heldSkillIds(tx, caller.userId, localDate(new Date(), timezone));
}

/** Refuses with 403 naming the first step whose skill the caller lacks. Partner moves never come here. */
export async function assertSkills(
  tx: Prisma.TransactionClient,
  caller: Caller,
  steps: { name: string; config: Prisma.JsonValue }[],
): Promise<void> {
  const requiring = steps.filter((step) => (step.config as StepConfig).required_skill_id);
  if (requiring.length === 0) {
    return;
  }
  const held = await skillsOf(tx, caller);
  const missing = held && requiring.find((step) => !held.has((step.config as StepConfig).required_skill_id!));
  if (missing) {
    const skill = await tx.skill.findUniqueOrThrow({
      where: { id: (missing.config as StepConfig).required_skill_id! },
      select: { name: true },
    });
    throw new ForbiddenException(`Moving pieces at ${missing.name} needs the skill ${skill.name}`);
  }
}

/** A skill a step requires that the caller doesn't hold, named so staff know whom to ask. */
export type MissingSkill = { id: string; name: string };

/**
 * The steps, across every workflow version, whose skill the caller doesn't hold today, each with that
 * skill; empty for the owner. One read: an archived skill is never held, so it stays missing and named.
 */
export async function barredSteps(tx: Prisma.TransactionClient, caller: Caller): Promise<Map<string, MissingSkill>> {
  const requiring = await tx.$queryRaw<{ id: string; skill_id: string; name: string }[]>`
    SELECT step.id, skill.id AS skill_id, skill.name
    FROM workflow_step step
    JOIN skill ON skill.id = (step.config->>'required_skill_id')::uuid
    WHERE step.config->>'required_skill_id' IS NOT NULL`;
  if (requiring.length === 0) {
    return new Map();
  }
  const held = await skillsOf(tx, caller);
  if (!held) {
    return new Map();
  }
  return new Map(requiring.filter((step) => !held.has(step.skill_id)).map((step) => [step.id, { id: step.skill_id, name: step.name }]));
}
