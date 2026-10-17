import { Injectable, UnauthorizedException } from '@nestjs/common';
import { newId } from '../../common/ids/uuid';
import { RateLimiter, tooManyAttempts } from '../../common/rate-limit/rate-limiter';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { AccessTokenService } from '../identity/access-token.service';
import type { TenantAuth } from '../identity/auth-context';
import { normalizeEmail } from '../identity/email';
import { issueOpaqueToken, parseOpaqueToken } from '../identity/opaque-token';
import { hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from '../identity/passwords';

/** 30 days (F3). */
const REFRESH_TOKEN_DAYS = 30;

/** Plan 2, P6: failed logins per tenant and email. */
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;

export interface SessionTokens {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

type RefreshOutcome = { kind: 'ok'; userId: string; refreshToken: string } | { kind: 'refused' };

function invalidCredentials(): UnauthorizedException {
  return new UnauthorizedException('Invalid credentials');
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AccessTokenService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
  ) {}

  /**
   * Every failure is the same 401, and an unknown tenant or email still costs
   * one password verification, so neither the answer nor its timing reveals
   * which tenants and emails exist.
   */
  async login(slug: string | undefined, email: string, password: string): Promise<SessionTokens> {
    const tenant = slug
      ? await this.prisma.tenant.findUnique({ where: { slug }, select: { id: true, status: true } })
      : null;

    if (!tenant) {
      await verifyAgainstDummy(password);
      throw invalidCredentials();
    }

    const normalized = normalizeEmail(email);
    const limitKey = `${tenant.id}:${normalized}`;
    if (await this.limiter.isBlocked('login', limitKey, LOGIN_LIMIT)) {
      throw tooManyAttempts();
    }

    const user = await this.prisma.inTenant(tenant.id, (tx) =>
      tx.user.findFirst({ where: { email: normalized } }),
    );
    const valid = user ? await verifyPassword(user.passwordHash, password) : await verifyAgainstDummy(password);

    if (!user || !valid || user.status !== 'active' || tenant.status !== 'active') {
      await this.limiter.hit('login', limitKey, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS);
      throw invalidCredentials();
    }
    await this.limiter.reset('login', limitKey);

    const refreshToken = await this.prisma.inTenant(tenant.id, async (tx) => {
      if (needsRehash(user.passwordHash)) {
        await tx.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
      }
      return this.issueRefreshToken(tx, tenant.id, user.id, newId(), null);
    });

    return this.sessionTokens(tenant.id, user.id, refreshToken);
  }

  /**
   * Rotation with reuse detection (F3). The presented token is claimed with a
   * conditional update, so of two concurrent refreshes only one can claim it;
   * the other sees it already revoked and is treated as reuse.
   *
   * Reuse revokes every live token in the family and is audited. The
   * transaction returns an outcome and the 401 is thrown only after it has
   * committed: throwing inside would roll the revocation back and leave the
   * attacker's token working.
   */
  async refresh(presented: string): Promise<SessionTokens> {
    const parsed = parseOpaqueToken(presented);
    if (!parsed) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const outcome = await this.prisma.inTenant(parsed.tenantId, async (tx): Promise<RefreshOutcome> => {
      const row = await tx.refreshToken.findUnique({
        where: { tokenHash: parsed.hash },
        include: { user: { select: { status: true, tenant: { select: { status: true } } } } },
      });
      if (!row) {
        return { kind: 'refused' };
      }

      const now = new Date();
      const claimed = await tx.refreshToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'rotated' },
      });

      if (claimed.count === 0) {
        // Already rotated, or rotated a moment ago by a concurrent request:
        // either way the token is being used twice. A token revoked for any
        // other reason (logout, reset, earlier reuse) is simply refused.
        if (row.revokedAt === null || row.revokedReason === 'rotated') {
          const revoked = await tx.refreshToken.updateMany({
            where: { familyId: row.familyId, revokedAt: null },
            data: { revokedAt: now, revokedReason: 'reuse_detected' },
          });
          await this.audit.record(tx, {
            actor: { type: 'user', id: row.userId },
            action: 'auth.refresh_chain_revoked',
            subject: { type: 'refresh_token_family', id: row.familyId },
            after: { revokedTokens: revoked.count },
          });
        }
        return { kind: 'refused' };
      }

      if (row.expiresAt <= now || row.user.status !== 'active' || row.user.tenant.status !== 'active') {
        return { kind: 'refused' };
      }

      const refreshToken = await this.issueRefreshToken(tx, parsed.tenantId, row.userId, row.familyId, row.id);
      return { kind: 'ok', userId: row.userId, refreshToken };
    });

    if (outcome.kind === 'refused') {
      throw new UnauthorizedException('Invalid refresh token');
    }
    return this.sessionTokens(parsed.tenantId, outcome.userId, outcome.refreshToken);
  }

  /** Revokes the caller's refresh token and denies their access token at once (F2). */
  async logout(auth: TenantAuth, presented: string): Promise<void> {
    const parsed = parseOpaqueToken(presented);

    if (parsed && parsed.tenantId === auth.tenantId) {
      await this.prisma.inTenant(auth.tenantId, (tx) =>
        tx.refreshToken.updateMany({
          where: { tokenHash: parsed.hash, userId: auth.userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'logout' },
        }),
      );
    }

    await this.tokens.deny(auth.jti, auth.expiresAt);
  }

  private async issueRefreshToken(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    familyId: string,
    rotatedFromId: string | null,
  ): Promise<string> {
    const { token, hash } = issueOpaqueToken(tenantId);
    await tx.refreshToken.create({
      data: {
        userId,
        tokenHash: hash,
        familyId,
        rotatedFromId,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    return token;
  }

  private async sessionTokens(tenantId: string, userId: string, refreshToken: string): Promise<SessionTokens> {
    const access = await this.tokens.issueForUser(tenantId, userId);
    return {
      access_token: access.accessToken,
      refresh_token: refreshToken,
      expires_at: access.expiresAt.toISOString(),
    };
  }
}
