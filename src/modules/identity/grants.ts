import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { TenantAuth } from './auth-context';

/** The part of the caller these rules read: who they are and what the guard says they may do. */
export type Caller = Pick<TenantAuth, 'userId' | 'permissions'>;

/** A role as the rules see it: its permissions come from the database, never from the request body. */
export type RoleRef = { name: string; isSystem: boolean; permissions: string[] };

const EXCEEDS_OWN_PERMISSIONS = "You can't give or take away a permission you don't have";
const OWNER_ONLY = 'Only an owner can do this to the owner role or an owner';
const PERSON_HOLDS_MORE = "This person has permissions you don't have";

/**
 * Whether the user holds the system owner role. The same query as `isOwner` in `users/skills.service.ts`,
 * kept here so identity does not import the users module.
 */
export async function callerIsOwner(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  const owners = await tx.userRole.count({ where: { userId, role: { name: 'owner', isSystem: true } } });
  return owners > 0;
}

/** The permissions of `wanted` that `held` lacks, sorted and without duplicates. */
export function missingPermissions(held: ReadonlySet<string>, wanted: Iterable<string>): string[] {
  return [...new Set(wanted)].filter((permission) => !held.has(permission)).sort();
}

/** An owner may grant and take away anything; anyone else only permissions they hold themselves. */
export function assertMayGrantPermissions(
  caller: Caller,
  isOwner: boolean,
  added: string[],
  removed: string[],
): void {
  if (isOwner) {
    return;
  }
  const missing = missingPermissions(caller.permissions, [...added, ...removed]);
  if (missing.length > 0) {
    throw new ForbiddenException({ code: 'exceeds_own_permissions', message: EXCEEDS_OWN_PERMISSIONS, permissions: missing });
  }
}

/**
 * Adding or removing roles. Only an owner touches the system `owner` role; a custom role that happens to
 * be named `owner` is an ordinary role. For every other role the caller needs each of its permissions.
 */
export function assertMayChangeRoles(caller: Caller, isOwner: boolean, added: RoleRef[], removed: RoleRef[]): void {
  const changed = [...added, ...removed];
  if (!isOwner && changed.some((role) => role.isSystem && role.name === 'owner')) {
    throw new ForbiddenException({ code: 'owner_only', message: OWNER_ONLY });
  }
  assertMayGrantPermissions(
    caller,
    isOwner,
    changed.flatMap((role) => role.permissions),
    [],
  );
}

/** Acting on a person (deactivating or reactivating them): not an owner, not someone holding more. */
export function assertMayManagePerson(
  caller: Caller,
  isOwner: boolean,
  target: { isOwner: boolean; permissions: string[] },
): void {
  if (isOwner) {
    return;
  }
  if (target.isOwner) {
    throw new ForbiddenException({ code: 'owner_only', message: OWNER_ONLY });
  }
  const missing = missingPermissions(caller.permissions, target.permissions);
  if (missing.length > 0) {
    throw new ForbiddenException({ code: 'person_holds_more', message: PERSON_HOLDS_MORE, permissions: missing });
  }
}

/** Nobody, an owner included, gives skills to themselves: someone else must vouch for them. */
export function assertNotOwnSkills(caller: Pick<Caller, 'userId'>, targetUserId: string): void {
  if (caller.userId === targetUserId) {
    throw new ForbiddenException({ code: 'own_skills', message: "You can't change your own skills" });
  }
}

/** The union of the permissions of the user's roles, sorted and without duplicates. */
export async function permissionsOfUser(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
  const rows = await tx.rolePermission.findMany({
    where: { role: { users: { some: { userId } } } },
    select: { permission: true },
  });
  return [...new Set(rows.map((row) => row.permission))].sort();
}
