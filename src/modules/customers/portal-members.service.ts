import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { CustomerAuth, TenantAuth } from '../identity/auth-context';
import { CustomerInvitationsService } from './customer-invitations.service';
import type {
  CustomerInvitationResponse,
  CustomerMemberResponse,
  PortalMeResponse,
} from './customer-response';
import { atLeast } from './customer-roles';
import type { CustomerRole } from './customer-roles';
import { lockCustomer, memberInclude, memberResponse } from './customers.service';

/**
 * What customer people do with their own organisation's people (Customers
 * spec, goals 3 and 4). Owners and admins invite, change and remove people;
 * only the owner makes someone else owner, and the owner stays until they
 * hand over. Changes run under the customer row lock, as staff changes do.
 */
@Injectable()
export class PortalMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly invitations: CustomerInvitationsService,
  ) {}

  /** Staff have no customers here: the portal is for customer people only. */
  async me(auth: TenantAuth): Promise<PortalMeResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: auth.userId },
        select: { id: true, name: true, email: true, kind: true },
      });
      if (user.kind !== 'customer') {
        throw new ForbiddenException('This route is for customer people');
      }
      const memberships = await tx.organisationMembership.findMany({
        where: { userId: user.id, organisationType: 'customer' },
        select: { organisationId: true, role: true },
      });
      const customers = await tx.customer.findMany({
        where: { id: { in: memberships.map((membership) => membership.organisationId) }, status: 'active' },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
      const roleOf = new Map(memberships.map((membership) => [membership.organisationId, membership.role]));
      return {
        user: { id: user.id, name: user.name, email: user.email },
        customers: customers.map((customer) => ({
          id: customer.id,
          name: customer.name,
          role: roleOf.get(customer.id) as CustomerRole,
        })),
      };
    });
  }

  /** Only an owner invites an owner, and then only when the customer has none. */
  async invite(auth: CustomerAuth, input: { email: string; role: CustomerRole }): Promise<CustomerInvitationResponse> {
    if (input.role === 'owner' && auth.role !== 'owner') {
      throw new ForbiddenException('Only the owner can invite an owner');
    }
    return this.invitations.invite(auth.tenantId, auth.customerId, { ...input, invitedByUserId: auth.userId });
  }

  /**
   * Admins change the roles of people below the owner. The owner hands over
   * with `owner` on someone else and becomes an admin; stepping down any
   * other way is refused, so the customer always has its one owner.
   */
  async changeRole(auth: CustomerAuth, userId: string, role: CustomerRole): Promise<CustomerMemberResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockCustomer(tx, auth.customerId);
      const target = await this.findMember(tx, auth.customerId, userId);
      const before = memberResponse(target);

      if (target.role === 'owner' || role === 'owner') {
        if (auth.role !== 'owner') {
          throw new ForbiddenException('Only the owner can change who is owner');
        }
        if (target.role === 'owner' && role !== 'owner') {
          throw new ConflictException('Make someone else owner first');
        }
      }

      if (role !== target.role) {
        if (role === 'owner') {
          await tx.organisationMembership.updateMany({
            where: { organisationType: 'customer', organisationId: auth.customerId, role: 'owner' },
            data: { role: 'admin' },
          });
        }
        await tx.organisationMembership.update({ where: { id: target.id }, data: { role } });
      }

      const after = memberResponse(
        await tx.organisationMembership.findUniqueOrThrow({ where: { id: target.id }, include: memberInclude }),
      );
      await this.record(tx, auth, before, after);
      return after;
    });
  }

  /** Owners and admins remove people; anyone leaves on their own; the owner is never removed. */
  async remove(auth: CustomerAuth, userId: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockCustomer(tx, auth.customerId);
      const target = await this.findMember(tx, auth.customerId, userId);
      if (target.role === 'owner') {
        throw new ConflictException('The owner cannot be removed; make someone else owner first');
      }
      if (userId !== auth.userId && !atLeast(auth.role, 'admin')) {
        throw new ForbiddenException();
      }
      await tx.organisationMembership.delete({ where: { id: target.id } });
      await this.record(tx, auth, memberResponse(target), undefined);
    });
  }

  private async findMember(tx: Prisma.TransactionClient, customerId: string, userId: string) {
    const membership = await tx.organisationMembership.findFirst({
      where: { userId, organisationType: 'customer', organisationId: customerId },
      include: memberInclude,
    });
    if (!membership) {
      throw new NotFoundException('Person not found');
    }
    return membership;
  }

  private async record(
    tx: Prisma.TransactionClient,
    auth: CustomerAuth,
    before: CustomerMemberResponse,
    after: CustomerMemberResponse | undefined,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'customer.member_changed',
      subject: { type: 'customer', id: auth.customerId },
      before,
      after,
    });
  }
}
