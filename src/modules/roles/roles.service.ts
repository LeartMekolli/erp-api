import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { assertMayGrantPermissions, callerIsOwner } from '../identity/grants';
import type { TenantPermission } from '../identity/permissions';
import { toRoleResponse } from './role-response';
import type { RoleResponse } from './role-response';

export type { RoleResponse } from './role-response';

/** An invitation still open: not accepted, not cancelled, not expired. */
const waitingInvitation = (now: Date): Prisma.InvitationWhereInput => ({
  acceptedAt: null,
  cancelledAt: null,
  expiresAt: { gt: now },
});

/**
 * Roles are data (D57). The two system roles are fixed (plan 2, P7); custom
 * roles are the tenant's own. Changes apply from the next request, because the
 * guard reads permissions every time. Nobody gives or takes away a permission
 * they don't hold themselves, unless they are an owner.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** A bounded list, so no cursor (ADR 0004 allows it for small admin lists). */
  async list(tenantId: string): Promise<{ data: RoleResponse[] }> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const roles = await tx.role.findMany({ include: { permissions: true }, orderBy: { name: 'asc' } });
      const counts = await this.countsFor(
        tx,
        roles.map((role) => role.id),
      );
      return { data: roles.map((role) => toRoleResponse(role, counts.get(role.id) ?? { members: 0, invitations: 0 })) };
    });
  }

  async create(auth: TenantAuth, input: { name: string; permissions: TenantPermission[] }): Promise<RoleResponse> {
    try {
      return await this.prisma.inTenant(auth.tenantId, async (tx) => {
        assertMayGrantPermissions(auth, await callerIsOwner(tx, auth.userId), input.permissions, []);

        const role = await tx.role.create({ data: { name: input.name } });
        await tx.rolePermission.createMany({
          data: input.permissions.map((permission) => ({ roleId: role.id, permission })),
        });
        const response = toRoleResponse(
          { ...role, permissions: input.permissions.map((permission) => ({ permission })) },
          { members: 0, invitations: 0 },
        );
        await this.audit.record(tx, {
          actor: { type: 'user', id: auth.userId },
          action: 'role.created',
          subject: { type: 'role', id: role.id },
          after: { name: response.name, permissions: response.permissions },
        });
        return response;
      });
    } catch (error) {
      this.rethrowNameTaken(error, input.name);
    }
  }

  async setPermissions(auth: TenantAuth, roleId: string, permissions: TenantPermission[]): Promise<RoleResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const role = await this.editableRole(tx, roleId);
      const before = role.permissions.map((row) => row.permission).sort();
      const wanted = new Set<string>(permissions);
      const held = new Set(before);
      assertMayGrantPermissions(
        auth,
        await callerIsOwner(tx, auth.userId),
        permissions.filter((permission) => !held.has(permission)),
        before.filter((permission) => !wanted.has(permission)),
      );

      await tx.rolePermission.deleteMany({ where: { roleId } });
      await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId, permission })) });

      const counts = (await this.countsFor(tx, [roleId])).get(roleId) ?? { members: 0, invitations: 0 };
      const response = toRoleResponse({ ...role, permissions: permissions.map((permission) => ({ permission })) }, counts);
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'role.permissions_changed',
        subject: { type: 'role', id: roleId },
        before: { permissions: before },
        after: { permissions: response.permissions },
      });
      return response;
    });
  }

  /** Renaming to the role's own name changes nothing and is not audited. */
  async rename(auth: TenantAuth, roleId: string, name: string): Promise<RoleResponse> {
    try {
      return await this.prisma.inTenant(auth.tenantId, async (tx) => {
        const role = await this.editableRole(tx, roleId);
        const changed = role.name !== name;
        const renamed = changed
          ? await tx.role.update({ where: { id: roleId }, data: { name }, include: { permissions: true } })
          : role;
        if (changed) {
          await this.audit.record(tx, {
            actor: { type: 'user', id: auth.userId },
            action: 'role.renamed',
            subject: { type: 'role', id: roleId },
            before: { name: role.name },
            after: { name },
          });
        }
        const counts = (await this.countsFor(tx, [roleId])).get(roleId) ?? { members: 0, invitations: 0 };
        return toRoleResponse(renamed, counts);
      });
    } catch (error) {
      this.rethrowNameTaken(error, name);
    }
  }

  /**
   * Assignments and waiting invitations with the role go with it. Refused when a person (active or not)
   * would be left with no role at all.
   */
  async delete(auth: TenantAuth, roleId: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const role = await this.editableRole(tx, roleId);
      const permissions = role.permissions.map((row) => row.permission).sort();
      assertMayGrantPermissions(auth, await callerIsOwner(tx, auth.userId), [], permissions);

      const holders = (await tx.userRole.findMany({ where: { roleId }, select: { userId: true } })).map(
        (row) => row.userId,
      );
      const rolesPerHolder = await tx.userRole.groupBy({
        by: ['userId'],
        where: { userId: { in: holders } },
        _count: { roleId: true },
      });
      const stranded = rolesPerHolder.filter((row) => row._count.roleId === 1).map((row) => row.userId);
      if (stranded.length > 0) {
        const people = await tx.user.findMany({
          where: { id: { in: stranded } },
          select: { id: true, name: true, status: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        });
        throw new ConflictException({
          code: 'only_role',
          message: 'Some people have no other role. Give them another role first',
          people,
        });
      }

      const invitationsCancelled = await tx.invitation.count({ where: { roleId, ...waitingInvitation(new Date()) } });
      await tx.role.delete({ where: { id: roleId } });
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'role.deleted',
        subject: { type: 'role', id: roleId },
        before: { name: role.name, permissions, invitations_cancelled: invitationsCancelled },
      });
    });
  }

  private async editableRole(tx: Prisma.TransactionClient, roleId: string) {
    const role = await tx.role.findUnique({ where: { id: roleId }, include: { permissions: true } });
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    if (role.isSystem) {
      throw new ConflictException({ code: 'system_role', message: 'System roles cannot be changed' });
    }
    return role;
  }

  /** Active members and waiting invitations per role, by two grouped counts. */
  private async countsFor(
    tx: Prisma.TransactionClient,
    roleIds: string[],
  ): Promise<Map<string, { members: number; invitations: number }>> {
    const [members, invitations] = await Promise.all([
      tx.userRole.groupBy({
        by: ['roleId'],
        where: { roleId: { in: roleIds }, user: { status: 'active' } },
        _count: { userId: true },
      }),
      tx.invitation.findMany({
        where: { roleId: { in: roleIds }, ...waitingInvitation(new Date()) },
        select: { roleId: true, email: true },
      }),
    ]);
    // An invitation whose email now belongs to a staff user is hidden from the invitations list, so it isn't counted.
    const staffEmails = new Set(
      invitations.length === 0
        ? []
        : (
            await tx.user.findMany({
              where: { kind: 'staff', email: { in: [...new Set(invitations.map((row) => row.email))] } },
              select: { email: true },
            })
          ).map((row) => row.email),
    );
    const counts = new Map<string, { members: number; invitations: number }>();
    for (const id of roleIds) {
      counts.set(id, { members: 0, invitations: 0 });
    }
    for (const row of members) {
      const entry = counts.get(row.roleId);
      if (entry) entry.members = row._count.userId;
    }
    for (const row of invitations) {
      const entry = counts.get(row.roleId);
      if (entry && !staffEmails.has(row.email)) entry.invitations++;
    }
    return counts;
  }

  private rethrowNameTaken(error: unknown, name: string): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException({ code: 'name_taken', message: `A role named ${name} already exists` });
    }
    throw error;
  }
}
