import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { decodeCursor } from '../../common/pagination/cursor';
import { Page, toPage } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import {
  type RoleRef,
  assertMayChangeRoles,
  assertMayManagePerson,
  callerIsOwner,
  permissionsOfUser,
} from '../identity/grants';
import { NotificationsService } from '../notifications/notifications.service';
import { localDate } from '../orders/dates';
import { HeldSkillResponse, StaffUserResponse, toStaffUserResponse } from './user-response';

export type UserStatus = 'active' | 'deactivated';

/**
 * A change that leaves no active user holding the system owner role would
 * lock the tenant out of its own administration (plan 2, P7). Checked inside
 * the change's transaction, after the change and before commit.
 */
export async function assertOwnerRemains(tx: Prisma.TransactionClient): Promise<void> {
  const owners = await tx.user.count({
    where: { status: 'active', roles: { some: { role: { name: 'owner', isSystem: true } } } },
  });
  if (owners === 0) {
    throw new ConflictException({ code: 'last_owner', message: 'A tenant must keep at least one active owner' });
  }
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    tenantId: string,
    query: { limit: number; cursor?: string; status?: UserStatus; q?: string },
  ): Promise<Page<StaffUserResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.user.findMany({
        // Customer people are listed with their customer, never as staff.
        where: {
          kind: 'staff',
          status: query.status,
          ...(query.q
            ? {
                OR: [
                  { name: { contains: query.q, mode: 'insensitive' } },
                  { email: { contains: query.q, mode: 'insensitive' } },
                ],
              }
            : {}),
          ...(after ? { id: { lt: after.id } } : {}),
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const page = toPage(rows, query.limit, secret);
      const ids = page.data.map((user) => user.id);

      const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
      const today = localDate(new Date(), timezone);
      const roleRows = await tx.userRole.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, role: { select: { id: true, name: true, isSystem: true } } },
      });
      const skillRows = await tx.userSkill.findMany({
        where: { userId: { in: ids } },
        select: {
          userId: true,
          expiresOn: true,
          skill: { select: { id: true, name: true, archivedAt: true } },
        },
      });

      const rolesOf = new Map<string, StaffUserResponse['roles']>();
      for (const { userId, role } of roleRows) {
        rolesOf.set(userId, [...(rolesOf.get(userId) ?? []), { id: role.id, name: role.name, is_system: role.isSystem }]);
      }
      const skillsOf = new Map<string, HeldSkillResponse[]>();
      for (const { userId, expiresOn, skill } of skillRows.sort(
        (a, b) => a.skill.name.localeCompare(b.skill.name) || a.skill.id.localeCompare(b.skill.id),
      )) {
        const day = expiresOn ? expiresOn.toISOString().slice(0, 10) : null;
        skillsOf.set(userId, [
          ...(skillsOf.get(userId) ?? []),
          { id: skill.id, name: skill.name, expires_on: day, expired: day !== null && day < today, archived: skill.archivedAt !== null },
        ]);
      }

      return {
        data: page.data.map((user) =>
          toStaffUserResponse(
            user,
            (rolesOf.get(user.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
            skillsOf.get(user.id) ?? [],
          ),
        ),
        next_cursor: page.next_cursor,
      };
    });
  }

  /** The privilege rules for acting on a person: not an owner unless the caller is one, not someone holding more. */
  private async assertMayManage(tx: Prisma.TransactionClient, auth: TenantAuth, userId: string): Promise<void> {
    assertMayManagePerson(auth, await callerIsOwner(tx, auth.userId), {
      isOwner: await callerIsOwner(tx, userId),
      permissions: await permissionsOfUser(tx, userId),
    });
  }

  /**
   * Idempotent. The user's refresh tokens are revoked with it; their access
   * token stops working at the next request, because the guard reads the
   * user's status every time.
   */
  async deactivate(auth: TenantAuth, userId: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      // Staff users only: a customer person is deactivated through its customer's members.
      const user = await tx.user.findFirst({ where: { id: userId, kind: 'staff' }, select: { status: true } });
      if (!user) {
        throw new NotFoundException('User not found');
      }
      if (userId === auth.userId) {
        throw new ConflictException({ code: 'own_account', message: "You can't deactivate yourself" });
      }
      await this.assertMayManage(tx, auth, userId);
      if (user.status === 'deactivated') {
        return;
      }

      await tx.user.update({ where: { id: userId }, data: { status: 'deactivated' } });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'logout' },
      });
      await assertOwnerRemains(tx);
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'user.deactivated',
        subject: { type: 'user', id: userId },
        before: { status: user.status },
        after: { status: 'deactivated' },
      });
    });
  }

  /**
   * Idempotent. Staff only. The user signs in again with their old password and keeps their roles and skills;
   * they are told once it has committed, and only when the status changed.
   */
  async reactivate(auth: TenantAuth, userId: string): Promise<void> {
    const result = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: userId, kind: 'staff' },
        select: { status: true, name: true },
      });
      if (!user) {
        throw new NotFoundException('User not found');
      }
      await this.assertMayManage(tx, auth, userId);
      if (user.status === 'active') {
        return { changed: false, userName: user.name, workspaceName: '' };
      }

      await tx.user.update({ where: { id: userId }, data: { status: 'active' } });
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'user.reactivated',
        subject: { type: 'user', id: userId },
        before: { status: user.status },
        after: { status: 'active' },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { name: true } });
      return { changed: true, userName: user.name, workspaceName: tenant.name };
    });

    if (result.changed) {
      await this.notifications.raise(auth.tenantId, 'user.reactivated', { type: 'user', id: userId }, {
        user_name: result.userName,
        workspace_name: result.workspaceName,
      });
    }
  }

  /**
   * Replaces the user's roles. Role ids the tenant cannot see are "not found".
   * When the set actually changed, the user is told once it has committed.
   */
  async setRoles(auth: TenantAuth, userId: string, roleIds: string[]): Promise<{ role_ids: string[] }> {
    const result = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      // Staff users only: a customer person never holds workspace roles.
      const user = await tx.user.findFirst({ where: { id: userId, kind: 'staff' }, select: { id: true, name: true } });
      if (!user) {
        throw new NotFoundException('User not found');
      }
      const roles = await tx.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } });
      if (roles.length !== roleIds.length) {
        throw new NotFoundException('Role not found');
      }

      const before = (await tx.userRole.findMany({ where: { userId }, select: { roleId: true } }))
        .map((row) => row.roleId)
        .sort();
      const after = [...roleIds].sort();

      // The privilege rules read each role's permissions from the database, before anything is written.
      const addedIds = after.filter((id) => !before.includes(id));
      const removedIds = before.filter((id) => !after.includes(id));
      const changedRoles = await tx.role.findMany({
        where: { id: { in: [...addedIds, ...removedIds] } },
        select: { id: true, name: true, isSystem: true, permissions: { select: { permission: true } } },
      });
      const refOf = (id: string): RoleRef => {
        const role = changedRoles.find((candidate) => candidate.id === id);
        if (!role) {
          throw new NotFoundException('Role not found');
        }
        return { name: role.name, isSystem: role.isSystem, permissions: role.permissions.map((row) => row.permission) };
      };
      assertMayChangeRoles(auth, await callerIsOwner(tx, auth.userId), addedIds.map(refOf), removedIds.map(refOf));

      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userRole.createMany({ data: after.map((roleId) => ({ userId, roleId })) });
      await assertOwnerRemains(tx);
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'user.roles_changed',
        subject: { type: 'user', id: userId },
        before: { role_ids: before },
        after: { role_ids: after },
      });

      return {
        role_ids: after,
        changed: before.join() !== after.join(),
        userName: user.name,
        roleNames: roles.map((role) => role.name).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
      };
    });

    if (result.changed) {
      await this.notifications.raise(auth.tenantId, 'user.roles_changed', { type: 'user', id: userId }, {
        user_name: result.userName,
        roles: result.roleNames.join(', '),
      });
    }

    return { role_ids: result.role_ids };
  }
}
