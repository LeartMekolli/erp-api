import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { IDENTITY_NOTIFIER } from '../identity/identity-notifier';
import type { IdentityNotifier } from '../identity/identity-notifier';
import { createInvitation } from '../identity/invitations';

export interface InvitationResponse {
  id: string;
  email: string;
  expires_at: string;
}

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IDENTITY_NOTIFIER) private readonly notifier: IdentityNotifier,
  ) {}

  /**
   * The token goes to the notifier, after commit, and never into the response:
   * whoever can read the response is not necessarily the invitee (D78).
   */
  async invite(
    tenantId: string,
    invitedByUserId: string,
    input: { email: string; roleId: string },
  ): Promise<InvitationResponse> {
    const invitation = await this.prisma.inTenant(tenantId, async (tx) => {
      // A role id from another tenant is invisible here, so it is "not found".
      if (!(await tx.role.findUnique({ where: { id: input.roleId }, select: { id: true } }))) {
        throw new NotFoundException('Role not found');
      }
      if (await tx.user.findFirst({ where: { email: input.email }, select: { id: true } })) {
        throw new ConflictException('A user with this email already exists');
      }
      return createInvitation(tx, tenantId, { email: input.email, roleId: input.roleId, invitedByUserId });
    });

    await this.notifier.invitationCreated({
      tenantId,
      invitationId: invitation.invitationId,
      email: input.email,
      token: invitation.token,
    });

    return { id: invitation.invitationId, email: input.email, expires_at: invitation.expiresAt.toISOString() };
  }
}
