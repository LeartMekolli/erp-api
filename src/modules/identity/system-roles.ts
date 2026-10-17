import type { Prisma } from '../../generated/prisma/client';
import { SYSTEM_ROLES, SystemRoleName } from './permissions';

/** Creates `owner` and `member` in the transaction's tenant; returns their ids. */
export async function createSystemRoles(
  tx: Prisma.TransactionClient,
): Promise<Record<SystemRoleName, string>> {
  const ids: Partial<Record<SystemRoleName, string>> = {};

  for (const [name, permissions] of Object.entries(SYSTEM_ROLES) as [SystemRoleName, readonly string[]][]) {
    const role = await tx.role.create({ data: { name, isSystem: true } });
    await tx.rolePermission.createMany({
      data: permissions.map((permission) => ({ roleId: role.id, permission })),
    });
    ids[name] = role.id;
  }

  return ids as Record<SystemRoleName, string>;
}
