import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AccessTokenService } from '../modules/identity/access-token.service';
import { normalizeEmail } from '../modules/identity/email';
import { hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from '../modules/identity/passwords';

export interface PlatformSession {
  access_token: string;
  expires_at: string;
}

/**
 * Platform admins get a 15-minute access token and no refresh token: they log
 * in again (plan 2, P1).
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AccessTokenService,
  ) {}

  /** Every failure is the same 401, and an unknown email costs a real verification. */
  async login(email: string, password: string): Promise<PlatformSession> {
    const admin = await this.prisma.platformAdmin.findUnique({ where: { email: normalizeEmail(email) } });

    if (!admin) {
      await verifyAgainstDummy(password);
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!(await verifyPassword(admin.passwordHash, password)) || admin.status !== 'active') {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (needsRehash(admin.passwordHash)) {
      await this.prisma.platformAdmin.update({
        where: { id: admin.id },
        data: { passwordHash: await hashPassword(password) },
      });
    }

    const issued = await this.tokens.issueForPlatformAdmin(admin.id);
    return { access_token: issued.accessToken, expires_at: issued.expiresAt.toISOString() };
  }
}
