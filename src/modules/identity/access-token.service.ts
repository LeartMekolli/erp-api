import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { newId } from '../../common/ids/uuid';
import { RedisService } from '../../redis/redis.service';

/** 15 minutes (F3). */
export const ACCESS_TOKEN_SECONDS = 900;

const claimsSchema = z
  .object({
    sub: z.uuid(),
    tid: z.uuid().optional(),
    scope: z.enum(['tenant', 'platform']),
    jti: z.uuid(),
    exp: z.number(),
  })
  .refine((claims) => (claims.scope === 'tenant') === (claims.tid !== undefined), {
    message: 'tenant tokens carry a tenant, platform tokens do not',
  });

export type AccessClaims = z.infer<typeof claimsSchema>;

export interface IssuedAccessToken {
  accessToken: string;
  expiresAt: Date;
  jti: string;
}

/**
 * HS256 access tokens. Algorithm and audience are pinned in `IdentityModule`
 * for both signing and verifying, so `alg: none` or another algorithm is
 * rejected. Revocation before expiry goes through the Redis denylist (F2).
 */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
  ) {}

  issueForUser(tenantId: string, userId: string): Promise<IssuedAccessToken> {
    return this.issue(userId, { scope: 'tenant', tid: tenantId });
  }

  issueForPlatformAdmin(platformAdminId: string): Promise<IssuedAccessToken> {
    return this.issue(platformAdminId, { scope: 'platform' });
  }

  async verify(token: string): Promise<AccessClaims> {
    try {
      const payload: unknown = await this.jwt.verifyAsync(token);
      return claimsSchema.parse(payload);
    } catch {
      throw new UnauthorizedException();
    }
  }

  /** Until the token would have expired anyway; nothing to do once it has. */
  async deny(jti: string, expiresAt: Date): Promise<void> {
    const seconds = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);
    if (seconds > 0) {
      await this.redis.client.set(this.denylistKey(jti), '1', 'EX', seconds);
    }
  }

  async isDenied(jti: string): Promise<boolean> {
    return (await this.redis.client.exists(this.denylistKey(jti))) === 1;
  }

  private async issue(
    subject: string,
    claims: { scope: 'tenant'; tid: string } | { scope: 'platform' },
  ): Promise<IssuedAccessToken> {
    const jti = newId();
    const accessToken = await this.jwt.signAsync({ ...claims, jti }, { subject });
    return { accessToken, jti, expiresAt: new Date(Date.now() + ACCESS_TOKEN_SECONDS * 1000) };
  }

  private denylistKey(jti: string): string {
    return `auth:denylist:${jti}`;
  }
}
