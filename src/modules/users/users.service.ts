import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { decodeCursor } from '../../common/pagination/cursor';
import { Page, toPage } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import { UserResponse, toUserResponse } from './user-response';

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
    throw new ConflictException('A tenant must keep at least one active owner');
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
    query: { limit: number; cursor?: string; status?: UserStatus },
  ): Promise<Page<UserResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    const rows = await this.prisma.inTenant(tenantId, (tx) =>
      tx.user.findMany({
        // Customer people are listed with their customer, never as staff.
        where: { kind: 'staff', status: query.status, ...(after ? { id: { lt: after.id } } : {}) },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      }),
    );
    const page = toPage(rows, query.limit, secret);
    return { data: page.data.map(toUserResponse), next_cursor: page.next_cursor };
  }

  /**
   * Idempotent. The user's refresh tokens are revoked with it; their access
   * token stops working at the next request, because the guard reads the
   * user's status every time.
   */
  async deactivate(auth: TenantAuth, userId: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
      if (!user) {
        throw new NotFoundException('User not found');
      }
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
   * Replaces the user's roles. Role ids the tenant cannot see are "not found".
   * When the set actually changed, the user is told once it has committed.
   */
  async setRoles(auth: TenantAuth, userId: string, roleIds: string[]): Promise<{ role_ids: string[] }> {
    const result = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
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
