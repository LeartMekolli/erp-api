import { UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { normalizeEmail } from '../identity/email';

/** Google's published signing keys; jose caches them and refetches on an unknown key id. */
export const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');

/** Google signs ID tokens with either spelling. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleIdentity {
  /** Google's stable id for the account; the email can change, this cannot. */
  subject: string;
  /** Lowercased, as every email in the system. */
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/** Bound to a verifier over Google's keys; e2e tests bind one over a local key. */
export const GOOGLE_TOKEN_VERIFIER = Symbol('GOOGLE_TOKEN_VERIFIER');

/**
 * Checks a Google ID token ourselves (Customers spec): the signature against
 * Google's keys, the issuer, an audience among the workspace's client ids,
 * and the expiry. Any failure is the same 401. Whether an unverified email
 * may be used is the caller's decision, so it is reported, not refused.
 */
export class GoogleTokenVerifier {
  constructor(private readonly keys: JWTVerifyGetKey = createRemoteJWKSet(GOOGLE_JWKS_URL)) {}

  async verify(idToken: string, clientIds: readonly string[]): Promise<GoogleIdentity> {
    if (clientIds.length === 0) {
      throw invalidGoogleToken();
    }

    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(idToken, this.keys, {
        issuer: GOOGLE_ISSUERS,
        audience: [...clientIds],
        algorithms: ['RS256'],
      }));
    } catch {
      throw invalidGoogleToken();
    }

    const { sub, email, email_verified: emailVerified, name } = payload;
    if (typeof sub !== 'string' || sub === '' || typeof email !== 'string' || email === '') {
      throw invalidGoogleToken();
    }
    return {
      subject: sub,
      email: normalizeEmail(email),
      emailVerified: emailVerified === true,
      name: typeof name === 'string' && name.trim() !== '' ? name.trim() : null,
    };
  }
}

export function invalidGoogleToken(): UnauthorizedException {
  return new UnauthorizedException('Invalid Google sign-in');
}
