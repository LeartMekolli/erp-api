import { z } from 'zod';

/** Emails are compared and stored trimmed and lowercased everywhere. */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(320));

/**
 * For lookups where a malformed address must behave like an unknown one, so
 * the response does not reveal anything (login, password reset).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
