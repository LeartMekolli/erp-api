import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * A 32-byte key for one purpose, derived from an application secret. The
 * `info` label separates purposes, so one secret can feed several keys
 * without any two being the same.
 */
export function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
}

/**
 * Encrypts and authenticates `plain`: IV, then GCM tag, then ciphertext. A
 * fresh IV per call means sealing the same text twice gives different bytes.
 */
export function seal(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Throws if the bytes were altered or sealed with another key. */
export function open(sealed: Buffer, key: Buffer): string {
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}
