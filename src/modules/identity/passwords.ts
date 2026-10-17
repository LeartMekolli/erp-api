import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { z } from 'zod';

/**
 * argon2id at the OWASP baseline (F1). The parameters are encoded into every
 * hash, so raising them later only needs `needsRehash` at the next login.
 */
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * The upper bound keeps a request from making the server hash megabytes of
 * input; 128 characters is far beyond any passphrase.
 */
export const passwordSchema = z.string().min(12).max(128);

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

/** False for a wrong password and for a stored hash it cannot parse. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, OPTIONS);
  } catch {
    return true;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Login for an unknown email runs one real verification against a throwaway
 * hash, so the response takes as long as a wrong password and the timing does
 * not reveal which emails exist.
 */
export async function verifyAgainstDummy(plain: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  await verifyPassword(await dummyHash, plain);
  return false;
}
