import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import type { TenantPermission } from '../identity/permissions';

export interface RoleResponse {
  id: string;
  name: string;
  is_system: boolean;
  permissions: string[];
}

function toRoleResponse(role: {
  id: string;
  name: string;
  isSystem: boolean;
  permissions: { permission: string }[];
}): RoleResponse {
  return {
    id: role.id,
    name: role.name,
    is_system: role.isSystem,
    permissions: role.permissions.map((row) => row.permission).sort(),
  };
}

/**
 * Roles are data (D57). The two system roles are fixed (plan 2, P7); custom
 * roles are the tenant's own. Changes apply from the next request, because the
 * guard reads permissions every time.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** A bounded list, so no cursor (ADR 0004 allows it for small admin lists). */
  async list(tenantId: string): Promise<{ data: RoleResponse[] }> {
    const roles = await this.prisma.inTenant(tenantId, (tx) =>
      tx.role.findMany({ include: { permissions: true }, orderBy: { name: 'asc' } }),
    );
    return { data: roles.map(toRoleResponse) };
  }

  async create(auth: TenantAuth, input: { name: string; permissions: TenantPermission[] }): Promise<RoleResponse> {
    try {
      return await this.prisma.inTenant(auth.tenantId, async (tx) => {
        const role = await tx.role.create({ data: { name: input.name } });
        await tx.rolePermission.createMany({
          data: input.permissions.map((permission) => ({ roleId: role.id, permission })),
        });
        const response = toRoleResponse({ ...role, permissions: input.permissions.map((permission) => ({ permission })) });
        await this.audit.record(tx, {
          actor: { type: 'user', id: auth.userId },
          action: 'role.created',
          subject: { type: 'role', id: role.id },
          after: { name: response.name, permissions: response.permissions },
        });
        return response;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`A role named ${input.name} already exists`);
      }
      throw error;
    }
  }

  async setPermissions(auth: TenantAuth, roleId: string, permissions: TenantPermission[]): Promise<RoleResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const role = await this.editableRole(tx, roleId);
      const before = toRoleResponse(role).permissions;

      await tx.rolePermission.deleteMany({ where: { roleId } });
      await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId, permission })) });

      const response = toRoleResponse({ ...role, permissions: permissions.map((permission) => ({ permission })) });
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

  /** Assignments and pending invitations with the role go with it. */
  async delete(auth: TenantAuth, roleId: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const role = await this.editableRole(tx, roleId);

      await tx.role.delete({ where: { id: roleId } });
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'role.deleted',
        subject: { type: 'role', id: roleId },
        before: { name: role.name, permissions: toRoleResponse(role).permissions },
      });
    });
  }

  private async editableRole(tx: Prisma.TransactionClient, roleId: string) {
    const role = await tx.role.findUnique({ where: { id: roleId }, include: { permissions: true } });
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    if (role.isSystem) {
      throw new ConflictException('System roles cannot be changed');
    }
    return role;
  }
}
