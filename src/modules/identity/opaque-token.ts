import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

const tenantIdSchema = z.uuid();

/** 32 random bytes in base64url, without padding. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Refresh, invitation and reset tokens: `<tenantId>.<secret>` (plan 2, P3).
 * The prefix is not secret; it tells the server which tenant to open before it
 * looks the token up in a row-level-secured table. Only the hash is stored, so
 * a database copy holds nothing usable.
 */
export function issueOpaqueToken(tenantId: string): { token: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${tenantId}.${secret}`, hash: hashSecret(secret) };
}

/** Null for anything we could not have issued; callers answer it like an unknown token. */
export function parseOpaqueToken(token: string): { tenantId: string; hash: string } | null {
  const parts = token.split('.');
  const [tenantId, secret] = parts;

  if (
    parts.length !== 2 ||
    !tenantIdSchema.safeParse(tenantId).success ||
    !secret ||
    !SECRET.test(secret)
  ) {
    return null;
  }

  return { tenantId: tenantId as string, hash: hashSecret(secret) };
}
