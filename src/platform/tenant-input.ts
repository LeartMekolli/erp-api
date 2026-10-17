import { z } from 'zod';
import { emailSchema } from '../modules/identity/email';

/** A DNS label: the slug is the tenant's login subdomain (F5). */
const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Subdomains the platform keeps for itself. */
const RESERVED_SLUGS = new Set(['www', 'api', 'admin', 'app', 'platform', 'static', 'mail']);

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

function canonicalLocale(value: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .regex(SLUG, 'slug must be lowercase letters, digits and hyphens, 1-63 characters')
    .refine((slug) => !RESERVED_SLUGS.has(slug), 'slug is reserved'),
  currency: z
    .string()
    .refine((code) => CURRENCIES.has(code), 'currency must be an ISO 4217 code, such as EUR'),
  locale: z.string().transform((value, ctx) => {
    const locale = canonicalLocale(value);
    if (!locale) {
      ctx.addIssue({ code: 'custom', message: 'locale must be a BCP 47 tag, such as en or de-AT' });
      return z.NEVER;
    }
    return locale;
  }),
  timezone: z.string().refine(isTimeZone, 'timezone must be an IANA zone, such as Europe/Berlin'),
  // Invited as the tenant's owner; nobody's password is ever configured (F6).
  ownerEmail: emailSchema,
});

export type CreateTenantInput = z.input<typeof createTenantSchema>;
