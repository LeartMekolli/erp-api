import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service';
import { hashPassword } from '../modules/identity/passwords';

// Demo staff for the skill a step requires (Workflow 2): the printed parts' in-house Final QC requires the
// Final QC skill. The seed's acting user moves the demo orders through it, so it holds the skill; a floor
// member who lacks it signs in to see which skill a row needs.

const FLOOR = { email: 'floor@demo.example.test', name: 'Demo floor' };
const SKILL = 'Final QC';

export interface StaffSeed {
  counts: {
    /** 1 when the acting user was given the skill now, 0 when it held it. */
    skills: number;
    members: number;
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
  const counts = { skills: 0, members: 0 };
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

    if (!(await tx.user.findFirst({ where: { email: FLOOR.email } }))) {
      const { defaultLocale } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultLocale: true } });
      const floor = await tx.user.create({ data: { ...FLOOR, passwordHash, locale: defaultLocale, kind: 'staff' } });
      const role = await tx.role.findFirstOrThrow({ where: { name: 'member', isSystem: true } });
      await tx.userRole.create({ data: { userId: floor.id, roleId: role.id } });
      counts.members++;
    }
  });

  return { counts, password: counts.members > 0 ? password : null };
}
