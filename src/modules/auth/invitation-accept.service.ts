import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { parseOpaqueToken } from '../identity/opaque-token';
import { hashPassword } from '../identity/passwords';

function invalidInvitation(): BadRequestException {
  return new BadRequestException('Invitation is invalid or expired');
}

@Injectable()
export class InvitationAcceptService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates the user with the invitation's email and role (F6). Unknown,
   * expired, already accepted and other-tenant tokens are all the same 400.
   * The invitation is claimed with a conditional update, so two concurrent
   * acceptances cannot both create a user.
   */
  async accept(token: string, name: string, password: string): Promise<void> {
    const parsed = parseOpaqueToken(token);
    if (!parsed) {
      throw invalidInvitation();
    }

    // Hashed before the transaction, which should not wait on argon2.
    const passwordHash = await hashPassword(password);

    try {
      await this.prisma.inTenant(parsed.tenantId, async (tx) => {
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
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A user with this email already exists');
      }
      throw error;
    }
  }
}
