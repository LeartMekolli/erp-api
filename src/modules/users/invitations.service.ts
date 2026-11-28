import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { TenantAuth } from '../identity/auth-context';
import { assertMayChangeRoles, callerIsOwner } from '../identity/grants';
import type { RoleRef } from '../identity/grants';
import { IDENTITY_NOTIFIER } from '../identity/identity-notifier';
import type { IdentityNotifier } from '../identity/identity-notifier';
import { createInvitation } from '../identity/invitations';
import { emailStatusOf, toInvitationResponse } from './invitation-response';
import type { InvitationEmailStatus, InvitationResponse } from './invitation-response';

const roleSelect = { id: true, name: true, isSystem: true, permissions: { select: { permission: true } } } as const;

function refOf(role: { name: string; isSystem: boolean; permissions: { permission: string }[] }): RoleRef {
  return { name: role.name, isSystem: role.isSystem, permissions: role.permissions.map((row) => row.permission) };
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IDENTITY_NOTIFIER) private readonly notifier: IdentityNotifier,
  ) {}

  /**
   * The token goes to the notifier, after commit, and never into the response:
   * whoever can read the response is not necessarily the invitee (D78).
   * Inviting again replaces a waiting invitation, so the caller needs the rules
   * for the new role and for each role the replaced invitations carried.
   */
  async invite(auth: TenantAuth, input: { email: string; roleId: string }): Promise<InvitationResponse> {
    const tenantId = auth.tenantId;
    const created = await this.prisma.inTenant(tenantId, async (tx) => {
      // A role id from another tenant is invisible here, so it is "not found".
      const role = await tx.role.findUnique({ where: { id: input.roleId }, select: roleSelect });
      if (!role) {
        throw new NotFoundException('Role not found');
      }

      const now = new Date();
      const waiting = await tx.invitation.findMany({
        where: { email: input.email, acceptedAt: null, cancelledAt: null, expiresAt: { gt: now } },
        select: { role: { select: roleSelect } },
      });
      assertMayChangeRoles(
        auth,
        await callerIsOwner(tx, auth.userId),
        [refOf(role), ...waiting.map((row) => refOf(row.role))],
        [],
      );

      const taken = await tx.user.findFirst({
        where: { email: input.email },
        select: { id: true, name: true, status: true, kind: true },
      });
      if (taken) {
        if (taken.kind === 'staff') {
          throw new ConflictException({
            code: 'email_is_staff',
            message: 'This email already belongs to someone on your team',
            user: { id: taken.id, name: taken.name, status: taken.status },
          });
        }
        throw new ConflictException({
          code: 'email_is_other_kind',
          message: 'This email belongs to a customer or partner person and cannot be invited as staff',
        });
      }

      const invitation = await createInvitation(tx, tenantId, {
        email: input.email,
        roleId: input.roleId,
        invitedByUserId: auth.userId,
      });
      const stored = await tx.invitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
        select: { createdAt: true },
      });
      const inviter = await tx.user.findUnique({ where: { id: auth.userId }, select: { id: true, name: true } });
      return {
        invitation,
        row: {
          id: invitation.invitationId,
          email: input.email,
          expiresAt: invitation.expiresAt,
          createdAt: stored.createdAt,
          role: { id: role.id, name: role.name },
          invitedBy: inviter,
        },
      };
    });

    const invitationId = created.invitation.invitationId;
    let emailStatus: InvitationEmailStatus | null;
    let raised = true;
    try {
      await this.notifier.invitationCreated({
        tenantId,
        invitationId,
        email: input.email,
        token: created.invitation.token,
      });
    } catch (error) {
      this.logger.error({ err: error, tenantId, invitationId }, 'a staff invitation email failed');
      raised = false;
    }
    if (!raised) {
      emailStatus = 'failed';
    } else {
      try {
        emailStatus = await this.prisma.inTenant(
          tenantId,
          async (tx) => (await emailStatusOf(tx, [invitationId])).get(invitationId) ?? null,
        );
      } catch (error) {
        this.logger.error({ err: error, tenantId, invitationId }, "reading a staff invitation's email status failed");
        emailStatus = null;
      }
    }

    return toInvitationResponse(created.row, emailStatus, new Date());
  }
}
