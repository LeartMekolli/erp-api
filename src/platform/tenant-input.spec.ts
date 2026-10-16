import { ZodError } from 'zod';
import { createTenantSchema } from './tenant-input';

const valid = {
  name: 'Example',
  slug: 'example',
  currency: 'EUR',
  locale: 'en',
  timezone: 'UTC',
};

describe('tenant input', () => {
  it('accepts a valid tenant', () => {
    expect(createTenantSchema.parse(valid)).toEqual(valid);
  });

  // The slug is the login subdomain (F5): its shape is a DNS label.
  it.each(['acme', 'acme-print', 'a1', 'a'.repeat(63)])('accepts the slug %s', (slug) => {
    expect(() => createTenantSchema.parse({ ...valid, slug })).not.toThrow();
  });

  it.each(['Acme', 'acme_print', '-acme', 'acme-', 'a'.repeat(64), '', 'acme.print'])(
    'rejects the slug "%s"',
    (slug) => {
      expect(() => createTenantSchema.parse({ ...valid, slug })).toThrow(ZodError);
    },
  );

  it.each(['www', 'api', 'admin'])('rejects the reserved slug %s', (slug) => {
    expect(() => createTenantSchema.parse({ ...valid, slug })).toThrow(ZodError);
  });

  it('trims the name and rejects a blank one', () => {
    expect(createTenantSchema.parse({ ...valid, name: '  Example  ' }).name).toBe('Example');
    expect(() => createTenantSchema.parse({ ...valid, name: '   ' })).toThrow(ZodError);
  });

  it.each(['EURO', 'eur', 'XYZ'])('rejects the currency %s', (currency) => {
    expect(() => createTenantSchema.parse({ ...valid, currency })).toThrow(ZodError);
  });

  it('canonicalises the locale and rejects an invalid one', () => {
    expect(createTenantSchema.parse({ ...valid, locale: 'en-us' }).locale).toBe('en-US');
    expect(() => createTenantSchema.parse({ ...valid, locale: 'not a locale' })).toThrow(ZodError);
  });

  it('accepts IANA time zones and rejects unknown ones', () => {
    expect(createTenantSchema.parse({ ...valid, timezone: 'Europe/Berlin' }).timezone).toBe(
      'Europe/Berlin',
    );
    expect(() => createTenantSchema.parse({ ...valid, timezone: 'Mars/Base' })).toThrow(ZodError);
  });
});
