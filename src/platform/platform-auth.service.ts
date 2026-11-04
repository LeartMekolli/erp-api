import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { newId } from '../common/ids/uuid';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import type { SessionTokens } from '../modules/auth/session.service';
import { AccessTokenService } from '../modules/identity/access-token.service';
import type { PlatformAuth } from '../modules/identity/auth-context';
import { normalizeEmail } from '../modules/identity/email';
import { issuePlatformToken, parsePlatformToken } from '../modules/identity/opaque-token';
import { hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from '../modules/identity/passwords';

/** How long a platform session lasts from login, however often it is refreshed: far shorter than a workspace's. */
const SESSION_HOURS = 12;

type RefreshOutcome = { kind: 'ok'; platformAdminId: string; refreshToken: string } | { kind: 'refused' };

/**
 * Platform admins get a 15-minute access token and a refresh token that rotates like a workspace's
 * (F3), with reuse detection. A session ends `SESSION_HOURS` after login: each rotated token keeps
 * the first one's expiry, so refreshing never lengthens it.
 */
@Injectable()
export class PlatformAuthService {
  private readonly logger = new Logger(PlatformAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AccessTokenService,
  ) {}

  /** Every failure is the same 401, and an unknown email costs a real verification. */
  async login(email: string, password: string): Promise<SessionTokens> {
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

    const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
    const refreshToken = await this.issueRefreshToken(this.prisma, admin.id, newId(), null, expiresAt);
    return this.sessionTokens(admin.id, refreshToken);
  }

  /**
   * As the workspace refresh: the presented token is claimed with a conditional update, so of two
   * concurrent refreshes only one wins and the other counts as reuse. Reuse revokes the whole family;
   * the 401 is thrown only after that has committed.
   */
  async refresh(presented: string): Promise<SessionTokens> {
    const parsed = parsePlatformToken(presented);
    if (!parsed) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const outcome = await this.prisma.$transaction(async (tx): Promise<RefreshOutcome> => {
      const row = await tx.platformRefreshToken.findUnique({
        where: { tokenHash: parsed.hash },
        include: { platformAdmin: { select: { status: true } } },
      });
      if (!row) {
        return { kind: 'refused' };
      }

      const now = new Date();
      const claimed = await tx.platformRefreshToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'rotated' },
      });
      if (claimed.count === 0) {
        // Used twice; a token revoked for another reason (logout, earlier reuse) is simply refused.
        if (row.revokedAt === null || row.revokedReason === 'rotated') {
          const revoked = await tx.platformRefreshToken.updateMany({
            where: { familyId: row.familyId, revokedAt: null },
            data: { revokedAt: now, revokedReason: 'reuse_detected' },
          });
          // No workspace to audit in: platform admins have none.
          this.logger.warn(
            { platformAdminId: row.platformAdminId, familyId: row.familyId, revokedTokens: revoked.count },
            'a platform refresh token was used twice; its session is revoked',
          );
        }
        return { kind: 'refused' };
      }

      if (row.expiresAt <= now || row.platformAdmin.status !== 'active') {
        return { kind: 'refused' };
      }

      const refreshToken = await this.issueRefreshToken(tx, row.platformAdminId, row.familyId, row.id, row.expiresAt);
      return { kind: 'ok', platformAdminId: row.platformAdminId, refreshToken };
    });

    if (outcome.kind === 'refused') {
      throw new UnauthorizedException('Invalid refresh token');
    }
    return this.sessionTokens(outcome.platformAdminId, outcome.refreshToken);
  }

  /** Revokes the caller's refresh token and denies their access token at once (F2). */
  async logout(auth: PlatformAuth, presented: string): Promise<void> {
    const parsed = parsePlatformToken(presented);
    if (parsed) {
      await this.prisma.platformRefreshToken.updateMany({
        where: { tokenHash: parsed.hash, platformAdminId: auth.platformAdminId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'logout' },
      });
    }
    await this.tokens.deny(auth.jti, auth.expiresAt);
  }

  private async issueRefreshToken(
    tx: Prisma.TransactionClient,
    platformAdminId: string,
    familyId: string,
    rotatedFromId: string | null,
    expiresAt: Date,
  ): Promise<string> {
    const { token, hash } = issuePlatformToken();
    await tx.platformRefreshToken.create({ data: { platformAdminId, tokenHash: hash, familyId, rotatedFromId, expiresAt } });
    return token;
  }

  private async sessionTokens(platformAdminId: string, refreshToken: string): Promise<SessionTokens> {
    const access = await this.tokens.issueForPlatformAdmin(platformAdminId);
    return { access_token: access.accessToken, refresh_token: refreshToken, expires_at: access.expiresAt.toISOString() };
  }
}
