import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { PartnerAuth, TenantAuth } from '../identity/auth-context';
import { PartnerInvitationsService } from './partner-invitations.service';
import type {
  PartnerInvitationResponse,
  PartnerMeResponse,
  PartnerMemberResponse,
  PartnerStatus,
} from './partner-response';
import type { PartnerRole } from './partner-roles';
import { lockPartner } from './partners.service';

const memberInclude = { user: { select: { id: true, name: true, email: true, status: true } } } as const;

function memberResponse(row: {
  role: string;
  user: { id: string; name: string; email: string; status: string };
}): PartnerMemberResponse {
  return {
    user_id: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: row.role as PartnerRole,
    status: row.user.status as PartnerMemberResponse['status'],
  };
}

/**
 * A partner's people, for staff and in the partner portal (Partners spec,
 * goal 1). Owners and admins invite and remove people; only the owner invites
 * an owner, and the owner is never removed. Changes run under the partner row lock.
 */
@Injectable()
export class PartnerMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly invitations: PartnerInvitationsService,
  ) {}

  /** The caller's partners, suspended ones included: those can still be read. The guard has checked the kind. */
  async me(auth: TenantAuth): Promise<PartnerMeResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { id: true, name: true, email: true } });
      const memberships = await tx.organisationMembership.findMany({
        where: { userId: user.id, organisationType: 'partner' },
        select: { organisationId: true, role: true },
      });
      const partners = await tx.partner.findMany({
        where: { id: { in: memberships.map((membership) => membership.organisationId) } },
        orderBy: { displayName: 'asc' },
        select: { id: true, displayName: true, status: true },
      });
      const roleOf = new Map(memberships.map((membership) => [membership.organisationId, membership.role]));
      return {
        user,
        partners: partners.map((partner) => ({
          id: partner.id,
          display_name: partner.displayName,
          role: roleOf.get(partner.id) as PartnerRole,
          status: partner.status as PartnerStatus,
        })),
      };
    });
  }

  /** The partner's people, in the order they joined. Another workspace's partner is not found. */
  async list(tenantId: string, partnerId: string): Promise<{ data: PartnerMemberResponse[] }> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      if ((await tx.partner.count({ where: { id: partnerId } })) === 0) {
        throw new NotFoundException('Partner not found');
      }
      const rows = await tx.organisationMembership.findMany({
        where: { organisationType: 'partner', organisationId: partnerId },
        orderBy: { id: 'asc' },
        include: memberInclude,
      });
      return { data: rows.map((row) => memberResponse(row)) };
    });
  }

  /** From the portal: only an owner invites an owner, and then only when the partner has none. */
  async invite(auth: PartnerAuth, input: { email: string; role: PartnerRole }): Promise<PartnerInvitationResponse> {
    if (input.role === 'owner' && auth.role !== 'owner') {
      throw new ForbiddenException('Only the owner can invite an owner');
    }
    return this.invitations.invite(auth.tenantId, auth.partnerId, { ...input, invitedByUserId: auth.userId });
  }

  /** The guard has checked the caller is an admin or the owner. The owner is never removed. */
  async remove(auth: PartnerAuth, userId: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockPartner(tx, auth.partnerId);
      const target = await tx.organisationMembership.findFirst({
        where: { userId, organisationType: 'partner', organisationId: auth.partnerId },
        include: memberInclude,
      });
      if (!target) {
        throw new NotFoundException('Person not found');
      }
      if (target.role === 'owner') {
        throw new ConflictException('The owner cannot be removed');
      }
      await tx.organisationMembership.delete({ where: { id: target.id } });
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'partner.member_changed',
        subject: { type: 'partner', id: auth.partnerId },
        before: memberResponse(target),
      });
    });
  }
}
