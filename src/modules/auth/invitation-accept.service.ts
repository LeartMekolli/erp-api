import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { parseOpaqueToken } from '../identity/opaque-token';
import { hashPassword } from '../identity/passwords';
import { NotificationsService } from '../notifications/notifications.service';

function invalidInvitation(): BadRequestException {
  return new BadRequestException('Invitation is invalid or expired');
}

@Injectable()
export class InvitationAcceptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Creates the user with the invitation's email and role (F6). Unknown,
   * expired, already accepted and other-tenant tokens are all the same 400.
   * The invitation is claimed with a conditional update, so two concurrent
   * acceptances cannot both create a user. Once committed, the people who
   * can invite users are told someone joined.
   */
  async accept(token: string, name: string, password: string): Promise<void> {
    const parsed = parseOpaqueToken(token);
    if (!parsed) {
      throw invalidInvitation();
    }

    // Hashed before the transaction, which should not wait on argon2.
    const passwordHash = await hashPassword(password);

    let joined: { id: string; name: string; email: string };
    try {
      joined = await this.prisma.inTenant(parsed.tenantId, async (tx) => {
        const now = new Date();
        const invitation = await tx.invitation.findUnique({ where: { tokenHash: parsed.hash } });
        if (!invitation || invitation.acceptedAt || invitation.expiresAt <= now) {
          throw invalidInvitation();
        }

        const tenant = await tx.tenant.findUnique({
          where: { id: parsed.tenantId },
          select: { status: true, defaultLocale: true },
        });
        if (!tenant || tenant.status !== 'active') {
          throw invalidInvitation();
        }

        const claimed = await tx.invitation.updateMany({
          where: { id: invitation.id, acceptedAt: null },
          data: { acceptedAt: now },
        });
        if (claimed.count === 0) {
          throw invalidInvitation();
        }

        const user = await tx.user.create({
          data: { email: invitation.email, passwordHash, name, locale: tenant.defaultLocale },
        });
        await tx.userRole.create({ data: { userId: user.id, roleId: invitation.roleId } });
        return { id: user.id, name: user.name, email: user.email };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A user with this email already exists');
      }
      throw error;
    }

    await this.notifications.raise(parsed.tenantId, 'user.joined', { type: 'user', id: joined.id }, {
      user_name: joined.name,
      user_email: joined.email,
    });
  }
}
