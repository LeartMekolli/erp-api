import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { RateLimiter, tooManyAttempts } from '../../common/rate-limit/rate-limiter';
import { PrismaService } from '../../database/prisma.service';
import { IDENTITY_NOTIFIER } from '../identity/identity-notifier';
import type { IdentityNotifier } from '../identity/identity-notifier';
import { normalizeEmail } from '../identity/email';
import { issueOpaqueToken, parseOpaqueToken } from '../identity/opaque-token';
import { hashPassword } from '../identity/passwords';

/** Plan 2, P4 and P6. */
const RESET_HOURS = 1;
const PER_EMAIL_LIMIT = 5;
const PER_IP_LIMIT = 20;
const WINDOW_SECONDS = 60 * 60;

function invalidReset(): BadRequestException {
  return new BadRequestException('Reset link is invalid or expired');
}

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: RateLimiter,
    @Inject(IDENTITY_NOTIFIER) private readonly notifier: IdentityNotifier,
  ) {}

  /**
   * Always resolves the same way for a known or unknown tenant and email, so
   * the endpoint cannot be used to find accounts. Only an active user gets a
   * notice, sent after commit; the caller never chooses the recipient (D78).
   */
  async request(slug: string | undefined, email: string, ip: string): Promise<void> {
    if (!(await this.limiter.hit('reset-ip', ip, PER_IP_LIMIT, WINDOW_SECONDS))) {
      throw tooManyAttempts();
    }

    const tenant = slug
      ? await this.prisma.tenant.findUnique({ where: { slug }, select: { id: true, status: true } })
      : null;
    if (!tenant || tenant.status !== 'active') {
      return;
    }

    const normalized = normalizeEmail(email);
    if (!(await this.limiter.hit('reset-email', `${tenant.id}:${normalized}`, PER_EMAIL_LIMIT, WINDOW_SECONDS))) {
      throw tooManyAttempts();
    }

    const issued = await this.prisma.inTenant(tenant.id, async (tx) => {
      const user = await tx.user.findFirst({ where: { email: normalized, status: 'active' }, select: { id: true } });
      if (!user) {
        return null;
      }

      const { token, hash } = issueOpaqueToken(tenant.id);
      await tx.passwordReset.create({
        data: {
          userId: user.id,
          tokenHash: hash,
          expiresAt: new Date(Date.now() + RESET_HOURS * 60 * 60 * 1000),
        },
      });
      return { userId: user.id, token };
    });

    if (issued) {
      await this.notifier.passwordResetRequested({
        tenantId: tenant.id,
        userId: issued.userId,
        email: normalized,
        token: issued.token,
      });
    }
  }

  /**
   * Single use: the reset is claimed with a conditional update. Setting a new
   * password revokes every refresh token the user holds, so a session opened
   * by whoever knew the old password ends with it. Access tokens already
   * issued run out within their 15 minutes.
   */
  async confirm(token: string, password: string): Promise<void> {
    const parsed = parseOpaqueToken(token);
    if (!parsed) {
      throw invalidReset();
    }

    const passwordHash = await hashPassword(password);

    await this.prisma.inTenant(parsed.tenantId, async (tx) => {
      const now = new Date();
      const reset = await tx.passwordReset.findUnique({
        where: { tokenHash: parsed.hash },
        include: { user: { select: { status: true } } },
      });
      if (!reset || reset.usedAt || reset.expiresAt <= now || reset.user.status !== 'active') {
        throw invalidReset();
      }

      const claimed = await tx.passwordReset.updateMany({
        where: { id: reset.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count === 0) {
        throw invalidReset();
      }

      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
      await tx.refreshToken.updateMany({
        where: { userId: reset.userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'password_reset' },
      });
    });
  }
}
