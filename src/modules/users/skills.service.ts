import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { localDate } from '../orders/dates';
import { SkillResponse, UserSkillResponse, toSkillResponse } from './skill-response';

/**
 * Whether the user may count on the skill on `today` (the workspace's calendar date): held, not archived,
 * and not past its last day (Workflow 2 spec, goal 10). Used by the move check (Task 2).
 */
export async function holdsSkill(
  tx: Prisma.TransactionClient,
  userId: string,
  skillId: string,
  today: string,
): Promise<boolean> {
  return (await heldSkillIds(tx, userId, today)).has(skillId);
}

/** Every skill the user may count on `today`, as `holdsSkill` decides it. */
export async function heldSkillIds(tx: Prisma.TransactionClient, userId: string, today: string): Promise<Set<string>> {
  const held = await tx.userSkill.findMany({
    where: { userId, skill: { archivedAt: null }, OR: [{ expiresOn: null }, { expiresOn: { gte: dateOf(today) } }] },
    select: { skillId: true },
  });
  return new Set(held.map((row) => row.skillId));
}

/** Whether the user holds the system owner role, who may always move pieces (goal 12). */
export async function isOwner(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  const owners = await tx.userRole.count({ where: { userId, role: { name: 'owner', isSystem: true } } });
  return owners > 0;
}

const dateOf = (day: string) => new Date(`${day}T00:00:00Z`);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The workspace's skill catalogue and the skills its staff hold (Workflow 2 spec, goals 9–10). Skill
 * names are configuration: unique per workspace regardless of case.
 */
@Injectable()
export class SkillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** A bounded list, so no cursor (ADR 0004 allows it for small admin lists). */
  async list(tenantId: string, includeArchived: boolean): Promise<{ data: SkillResponse[] }> {
    const skills = await this.prisma.inTenant(tenantId, (tx) =>
      tx.skill.findMany({ where: includeArchived ? {} : { archivedAt: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    );
    return { data: skills.map(toSkillResponse) };
  }

  async create(auth: TenantAuth, name: string): Promise<SkillResponse> {
    return this.uniqueName(name, () =>
      this.prisma.inTenant(auth.tenantId, async (tx) => {
        await this.assertNameFree(tx, name);
        const skill = await tx.skill.create({ data: { name } });
        await this.audit.record(tx, {
          actor: { type: 'user', id: auth.userId },
          action: 'skill.changed',
          subject: { type: 'skill', id: skill.id },
          after: { name },
        });
        return toSkillResponse(skill);
      }),
    );
  }

  /** Renames, archives or restores a skill. Staff holding an archived skill keep the row; it counts as not held. */
  async update(auth: TenantAuth, id: string, input: { name?: string; archived?: boolean }): Promise<SkillResponse> {
    return this.uniqueName(input.name ?? '', () =>
      this.prisma.inTenant(auth.tenantId, async (tx) => {
        const skill = await tx.skill.findFirst({ where: { id } });
        if (!skill) {
          throw new NotFoundException('Skill not found');
        }
        if (input.name !== undefined && input.name !== skill.name) {
          await this.assertNameFree(tx, input.name, id);
        }
        const archivedAt =
          input.archived === undefined ? skill.archivedAt : input.archived ? (skill.archivedAt ?? new Date()) : null;
        const updated = await tx.skill.update({ where: { id }, data: { name: input.name ?? skill.name, archivedAt } });
        await this.audit.record(tx, {
          actor: { type: 'user', id: auth.userId },
          action: 'skill.changed',
          subject: { type: 'skill', id },
          before: { name: skill.name, archived: skill.archivedAt !== null },
          after: { name: updated.name, archived: updated.archivedAt !== null },
        });
        return toSkillResponse(updated);
      }),
    );
  }

  async listOfUser(tenantId: string, userId: string): Promise<{ data: UserSkillResponse[] }> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      await this.staffUser(tx, userId);
      return { data: await this.heldBy(tx, tenantId, userId) };
    });
  }

  /**
   * Replaces the user's whole set of skills, as `PUT /users/:id/roles` does. An archived or unknown skill
   * is a 400 and changes nothing. Audited with the skills before and after, in id order.
   */
  async setOfUser(
    auth: TenantAuth,
    userId: string,
    skills: { skill_id: string; expires_on: string | null }[],
  ): Promise<{ data: UserSkillResponse[] }> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.staffUser(tx, userId);
      const ids = skills.map((held) => held.skill_id);
      const usable = await tx.skill.count({ where: { id: { in: ids }, archivedAt: null } });
      if (usable !== ids.length) {
        throw new BadRequestException('Only skills in the catalogue that are not archived can be given');
      }

      const before = (await tx.userSkill.findMany({ where: { userId } }))
        .map((held) => ({ skill_id: held.skillId, expires_on: held.expiresOn ? dayOf(held.expiresOn) : null }))
        .sort((a, b) => a.skill_id.localeCompare(b.skill_id));
      const after = [...skills].sort((a, b) => a.skill_id.localeCompare(b.skill_id));

      await tx.userSkill.deleteMany({ where: { userId } });
      await tx.userSkill.createMany({
        data: after.map((held) => ({
          userId,
          skillId: held.skill_id,
          expiresOn: held.expires_on ? dateOf(held.expires_on) : null,
          grantedByUserId: auth.userId,
        })),
      });
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'user.skills_changed',
        subject: { type: 'user', id: userId },
        before: { skills: before },
        after: { skills: after },
      });

      return { data: await this.heldBy(tx, auth.tenantId, userId) };
    });
  }

  /** Staff users only: a customer person never holds workspace skills. */
  private async staffUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const user = await tx.user.findFirst({ where: { id: userId, kind: 'staff' }, select: { id: true } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
  }

  private async heldBy(tx: Prisma.TransactionClient, tenantId: string, userId: string): Promise<UserSkillResponse[]> {
    const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
    const today = localDate(new Date(), timezone);
    const held = await tx.userSkill.findMany({
      where: { userId },
      include: { skill: { select: { id: true, name: true } } },
      orderBy: [{ skill: { name: 'asc' } }, { skillId: 'asc' }],
    });
    return held.map((row) => {
      const expiresOn = row.expiresOn ? dayOf(row.expiresOn) : null;
      return { skill: row.skill, expires_on: expiresOn, expired: expiresOn !== null && expiresOn < today };
    });
  }

  private async assertNameFree(tx: Prisma.TransactionClient, name: string, exceptId?: string): Promise<void> {
    const taken = await tx.skill.count({
      where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (taken > 0) {
      throw new ConflictException(`A skill named ${name} already exists`);
    }
  }

  /** Two requests racing for one name: the unique index on lower(name) refuses the second. */
  private async uniqueName<T>(name: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`A skill named ${name} already exists`);
      }
      throw error;
    }
  }
}
