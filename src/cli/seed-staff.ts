import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service';
import { issueOpaqueToken } from '../modules/identity/opaque-token';
import { hashPassword } from '../modules/identity/passwords';
import { localDate } from '../modules/orders/dates';

// Demo staff for the skill a step requires (Workflow 2): the printed parts' in-house Final QC requires the
// Final QC skill. The seed's acting user moves the demo orders through it, so it holds the skill; a floor
// member who lacks it signs in to see which skill a row needs.

const FLOOR = { email: 'floor@demo.example.test', name: 'Demo floor' };
const SKILL = 'Final QC';

// Settings > People demo: a limited custom role and its holder, a deactivated person, a waiting and an
// expired invitation, a skill that runs out soon and an archived skill someone still holds.
const LEAD = { email: 'lead@demo.example.test', name: 'Demo production lead' };
const LEAD_ROLE = 'Production lead';
const LEAD_PERMISSIONS = ['order.read', 'role.assign', 'role.read', 'user.read', 'workflow.move', 'workflow.read'];
const FORMER = { email: 'former@demo.example.test', name: 'Demo former member' };
const WAITING_INVITE = 'waiting@demo.example.test';
const EXPIRED_INVITE = 'expired@demo.example.test';
const ARCHIVED_SKILL = 'Sand casting';
const DAY_MS = 86_400_000;
/** The lead's Final QC runs out this many days after the day it is first seeded (inside the 30-day window). */
const EXPIRES_IN_DAYS = 14;

export interface StaffSeed {
  counts: {
    /** 1 when the acting user was given the skill now, 0 when it held it. */
    skills: number;
    members: number;
    /** The production lead and the deactivated person created now. */
    people: number;
    /** The waiting and the expired invitation created now. */
    invitations: number;
    /** The Production lead role created now. */
    roles: number;
  };
  /** The floor member's password when created now; null when it existed. */
  password: string | null;
}

/**
 * Seeds the acting user's Final QC skill and the floor member into one workspace whose workflows are
 * seeded. Idempotent: the skill held and the member found by email are left as they are. A new member
 * gets `options.password`, else a random one, returned for the caller to print once.
 */
export async function seedStaff(
  prisma: PrismaService,
  tenantId: string,
  options: { actingUserId: string; password?: string },
): Promise<StaffSeed> {
  const counts = { skills: 0, members: 0, people: 0, invitations: 0, roles: 0 };
  const password = options.password ?? randomBytes(16).toString('base64url');
  // Hashed once, before the transaction, which should not wait on argon2.
  const passwordHash = await hashPassword(password);

  await prisma.inTenant(tenantId, async (tx) => {
    const skill = await tx.skill.findFirst({ where: { name: { equals: SKILL, mode: 'insensitive' } } });
    if (!skill) {
      throw new Error(`Demo staff need the ${SKILL} skill; seed the workflows first`);
    }

    if (!(await tx.userSkill.findFirst({ where: { userId: options.actingUserId, skillId: skill.id } }))) {
      await tx.userSkill.create({
        data: { userId: options.actingUserId, skillId: skill.id, expiresOn: null, grantedByUserId: options.actingUserId },
      });
      counts.skills++;
    }

    const { defaultLocale, timezone } = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { defaultLocale: true, timezone: true },
    });
    const memberRole = await tx.role.findFirstOrThrow({ where: { name: 'member', isSystem: true } });

    if (!(await tx.user.findFirst({ where: { email: FLOOR.email } }))) {
      const floor = await tx.user.create({ data: { ...FLOOR, passwordHash, locale: defaultLocale, kind: 'staff' } });
      await tx.userRole.create({ data: { userId: floor.id, roleId: memberRole.id } });
      counts.members++;
    }

    let leadRole = await tx.role.findFirst({ where: { name: LEAD_ROLE } });
    if (!leadRole) {
      leadRole = await tx.role.create({
        data: { name: LEAD_ROLE, permissions: { create: LEAD_PERMISSIONS.map((permission) => ({ permission })) } },
      });
      counts.roles++;
    }

    // The lead holds only that role. Its skills are given only when it is created, so the date below is
    // relative to the first run: an old local database may have drifted past the 30-day window.
    if (!(await tx.user.findFirst({ where: { email: LEAD.email } }))) {
      const lead = await tx.user.create({ data: { ...LEAD, passwordHash, locale: defaultLocale, kind: 'staff' } });
      await tx.userRole.create({ data: { userId: lead.id, roleId: leadRole.id } });
      const lastDay = localDate(new Date(Date.now() + EXPIRES_IN_DAYS * DAY_MS), timezone);
      await tx.userSkill.create({
        data: { userId: lead.id, skillId: skill.id, expiresOn: new Date(`${lastDay}T00:00:00Z`), grantedByUserId: options.actingUserId },
      });
      let archived = await tx.skill.findFirst({ where: { name: { equals: ARCHIVED_SKILL, mode: 'insensitive' } } });
      if (!archived) {
        archived = await tx.skill.create({ data: { name: ARCHIVED_SKILL, archivedAt: new Date() } });
      } else if (!archived.archivedAt) {
        archived = await tx.skill.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
      }
      await tx.userSkill.create({
        data: { userId: lead.id, skillId: archived.id, expiresOn: null, grantedByUserId: options.actingUserId },
      });
      counts.people++;
    }

    if (!(await tx.user.findFirst({ where: { email: FORMER.email } }))) {
      const former = await tx.user.create({
        data: { ...FORMER, passwordHash, locale: defaultLocale, kind: 'staff', status: 'deactivated' },
      });
      await tx.userRole.create({ data: { userId: former.id, roleId: memberRole.id } });
      counts.people++;
    }

    // Inserted directly: no email goes out. Only the token's hash is kept; the token is dropped.
    const now = Date.now();
    for (const [email, expiresAt] of [
      [WAITING_INVITE, new Date(now + 5 * DAY_MS)],
      [EXPIRED_INVITE, new Date(now - 2 * DAY_MS)],
    ] as const) {
      if (await tx.invitation.findFirst({ where: { email } })) continue;
      await tx.invitation.create({
        data: { email, roleId: memberRole.id, tokenHash: issueOpaqueToken(tenantId).hash, invitedByUserId: options.actingUserId, expiresAt },
      });
      counts.invitations++;
    }
  });

  return { counts, password: counts.members + counts.people > 0 ? password : null };
}
