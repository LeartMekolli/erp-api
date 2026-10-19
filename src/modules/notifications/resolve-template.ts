import { EVENTS, EventKey } from './catalogue';
import type { Template } from './render';

export interface StoredOverride {
  locale: string;
  subject: string;
  body: string;
  enabled: boolean;
}

/**
 * The wording one recipient gets (plan N5). For each locale in order — the
 * recipient's, the tenant's, then English — an enabled tenant override wins,
 * then a repo default. Repo defaults exist in English, so there is always one.
 */
export function resolveTemplate(event: EventKey, locales: string[], overrides: StoredOverride[]): Template {
  const defaults: Record<string, Template> = EVENTS[event].defaults;

  for (const locale of new Set([...locales, 'en'])) {
    const override = overrides.find((candidate) => candidate.locale === locale && candidate.enabled);
    if (override) {
      return { subject: override.subject, body: override.body };
    }
    const fallback = defaults[locale];
    if (fallback) {
      return { subject: fallback.subject, body: fallback.body };
    }
  }

  return EVENTS[event].defaults.en;
}
