import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export interface GoogleClaims {
  aud: string;
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  iss?: string;
  /** A jose time span such as '5m', or seconds since the epoch. */
  expiresAt?: string | number;
}

export interface TestGoogleKeys {
  /** Stands in for Google's published keys. */
  keySet: JWTVerifyGetKey;
  /** An ID token as Google would sign it, signed with this key instead. */
  mint(claims: GoogleClaims): Promise<string>;
}

/** A local signing key, so tests never call Google. */
export async function testGoogleKeys(): Promise<TestGoogleKeys> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  return {
    keySet: createLocalJWKSet({ keys: [jwk] }),
    mint: (claims) =>
      new SignJWT({
        ...(claims.email === undefined ? {} : { email: claims.email }),
        email_verified: claims.email_verified ?? true,
        ...(claims.name === undefined ? {} : { name: claims.name }),
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(claims.iss ?? 'https://accounts.google.com')
        .setAudience(claims.aud)
        .setSubject(claims.sub)
        .setIssuedAt()
        .setExpirationTime(claims.expiresAt ?? '5m')
        .sign(privateKey),
  };
}
